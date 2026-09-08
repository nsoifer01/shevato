import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rankQuotes, money, isFresh, freshness, VERTICALS, STATUSES, MODE_LABELS, STATUS_LABELS, CONTINUE_URLS } from '../js/model.js';
const now = Date.now();
const q = (id, amount, extra={}) => ({ id, amount, annual: amount*12, currency:'USD', status:'AUTHORITATIVE PUBLIC RATE', expiresAt:new Date(now+60000).toISOString(), comparisonKey:'same', comparisonLabel:'Same product', vertical:'health-insurance', ...extra });
test('every listed vertical works, and declares dimensions and a defensible ranking', () => {
  assert.equal(VERTICALS.length,4);
  for (const v of VERTICALS) {
    assert.ok(v.dimensions.length,v.id);
    assert.ok(v.modes.includes('cheapest'),v.id);
    assert.ok(v.modes.every(m=>Object.hasOwn(MODE_LABELS,m)),v.id);
    // Nothing is listed that cannot be priced, so nothing carries an excuse.
    assert.equal(v.reason,undefined,`${v.id} still carries an unavailability reason`);
  }
  assert.ok(STATUSES.includes('ERROR')); assert.ok(STATUSES.includes('AUTHORITATIVE PUBLIC RATE'));
  assert.ok(CONTINUE_URLS.every(u=>/^https:\/\/www\.(healthcare|medicare)\.gov\//.test(u)),'outbound handoffs stay on the official sites');
});
test('cheapest uses cents and stable ties', () => { assert.deepEqual(rankQuotes([q('c',200),q('b',100),q('a',100)])[0].quotes.map(q=>q.id),['a','b','c']); });
test('a verified quote breaks an exact tie, published rates never become verified', () => { const items=rankQuotes([q('a',100),q('b',100,{status:'VERIFIED QUOTE'})])[0].quotes; assert.equal(items[0].id,'b');assert.equal(items[1].status,'AUTHORITATIVE PUBLIC RATE'); });
test('different currencies and coverage stay separate', () => { assert.equal(rankQuotes([q('a',100),q('b',90,{currency:'EUR'}),q('c',80,{comparisonKey:'other'})]).length,3); });
test('unavailable, expired and errors are excluded', () => { assert.equal(rankQuotes(['ERROR','UNAVAILABLE','EXPIRED'].map((status,i)=>q(String(i),100,{status}))).length,0); assert.equal(isFresh(q('a',1,{expiresAt:new Date(now-1).toISOString()})),false); });
test('best value uses worst-case covered care, not expected cost', () => { const g=rankQuotes([q('a',100,{outOfPocket:10000}),q('b',200,{outOfPocket:1000})],'best-value')[0];assert.equal(g.quotes[0].id,'b');assert.match(g.reason,/not expected/); });
test('best rated puts the highest stars first and unrated plans last', () => {
  const g=rankQuotes([q('unrated',1,{rating:null}),q('three',300,{rating:3}),q('five',900,{rating:5})],'best-rated')[0];
  assert.deepEqual(g.quotes.map(x=>x.id),['five','three','unrated']);
  assert.match(g.reason,/not whether the plan suits you/);
});
test('lowest deductible puts missing values last', () => { const g=rankQuotes([q('a',1,{deductible:null}),q('b',2,{deductible:500})],'lowest-deductible')[0]; assert.equal(g.quotes[0].id,'b'); });
test('money does not invent missing or fractional cents', () => { assert.equal(money(null),'Not reported');assert.equal(money(1.1),'Not reported');assert.equal(money(1234),'$12.34'); });
test('production routing refuses fixture files even when present in publish root', async () => {
  const { readFile } = await import('node:fs/promises');
  const config = await readFile(new URL('../../../netlify.toml', import.meta.url),'utf8');
  for (const route of ['/apps/quotescout/tests/*','/apps/quotescout/e2e/*','/netlify/functions/tests/*']) {
    const block = config.split('[[redirects]]').find(b => b.includes(`from = "${route}"`));
    assert.ok(block,route);assert.match(block,/status = 404/);assert.match(block,/force = true/);
  }
});
