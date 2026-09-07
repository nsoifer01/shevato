import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rankQuotes, money, isFresh, VERTICALS, STATUSES } from '../js/model.js';
const now = Date.now();
const q = (id, amount, extra={}) => ({ id, amount, annual: amount*12, currency:'USD', status:'ESTIMATE', expiresAt:new Date(now+60000).toISOString(), comparisonKey:'same', comparisonLabel:'Same product', vertical:'package-shipping', deliveryDays:3, ...extra });
test('all eight verticals declare comparison dimensions and ranking', () => { assert.equal(VERTICALS.length,8); for (const v of VERTICALS) { assert.ok(v.dimensions.length); assert.ok(v.modes.includes('cheapest')); assert.ok(v.modes.includes('best-value')); } assert.ok(STATUSES.includes('ERROR')); });
test('cheapest uses cents and stable ties', () => { assert.deepEqual(rankQuotes([q('c',200),q('b',100),q('a',100)])[0].quotes.map(q=>q.id),['a','b','c']); });
test('a verified quote breaks an exact tie, estimates never become verified', () => { const items=rankQuotes([q('a',100),q('b',100,{status:'VERIFIED QUOTE'})])[0].quotes; assert.equal(items[0].id,'b');assert.equal(items[1].status,'ESTIMATE'); });
test('different currencies and coverage stay separate', () => { assert.equal(rankQuotes([q('a',100),q('b',90,{currency:'EUR'}),q('c',80,{comparisonKey:'other'})]).length,3); });
test('unavailable, expired and errors are excluded', () => { assert.equal(rankQuotes(['ERROR','UNAVAILABLE','EXPIRED'].map((status,i)=>q(String(i),100,{status}))).length,0); assert.equal(isFresh(q('a',1,{expiresAt:new Date(now-1).toISOString()})),false); });
test('fastest sorts unknown delivery last and uses price for ties', () => { assert.deepEqual(rankQuotes([q('a',1,{deliveryDays:null}),q('b',200,{deliveryDays:1}),q('c',100,{deliveryDays:1})],'fastest')[0].quotes.map(q=>q.id),['c','b','a']); });
test('best value shipping transparently trades price for transit', () => { const g=rankQuotes([q('slow',100,{deliveryDays:9}),q('fast',200,{deliveryDays:1})],'best-value')[0];assert.equal(g.quotes[0].id,'fast');assert.match(g.reason,/\$1/); });
test('health best value uses worst-case covered care, not expected cost', () => { const g=rankQuotes([q('a',100,{vertical:'health-insurance',outOfPocket:10000}),q('b',200,{vertical:'health-insurance',outOfPocket:1000})],'best-value')[0];assert.equal(g.quotes[0].id,'b');assert.match(g.reason,/not expected/); });
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
