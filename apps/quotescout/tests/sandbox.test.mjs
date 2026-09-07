import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAdapters } from '../../../netlify/functions/lib/quotescout/adapters.mjs';
import { deadline } from '../../../netlify/functions/lib/quotescout/http.mjs';
test('opt-in NHTSA public API contract, documented sample VIN only', { skip: process.env.QUOTESCOUT_PUBLIC_API_TEST !== '1' }, async () => {
  const adapter=createAdapters().find(a=>a.id==='vpic');
  const result=await deadline(signal=>adapter.quote({vin:'1HGCM82633A004352'},{signal,enrich:(_k,_ttl,f)=>f(),reserve:async()=>true}),12000);
  assert.equal(result.vehicle.make,'HONDA');assert.equal(result.vehicle.model,'Accord');assert.equal(result.quotes.length,0);
});
