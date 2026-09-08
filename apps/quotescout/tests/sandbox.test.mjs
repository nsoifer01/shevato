import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAdapters } from '../../../netlify/functions/lib/quotescout/adapters.mjs';
import { deadline } from '../../../netlify/functions/lib/quotescout/http.mjs';
test('opt-in NHTSA public API contract, documented sample VIN only', { skip: process.env.QUOTESCOUT_PUBLIC_API_TEST !== '1' }, async () => {
  const adapter=createAdapters().find(a=>a.id==='vpic');
  const result=await deadline(signal=>adapter.quote({vin:'1HGCM82633A004352'},{signal,enrich:(_k,_ttl,f)=>f(),reserve:async()=>true}),12000);
  assert.equal(result.vehicle.make,'HONDA');assert.equal(result.vehicle.model,'Accord');assert.equal(result.quotes.length,0);
});

// Opt-in re-verification of the shipped dataset against the live CMS source.
// This is the check that lets Quote Scout call these numbers real: it downloads
// the current Rate PUF and compares the premium the app would show against the
// premium CMS published, for every state, across the age range and both tobacco
// settings. Roughly 300 MB and a few minutes, so it never runs by default; run
// it after regenerating the dataset, and whenever CMS republishes a plan year.
//
//   QUOTESCOUT_PUBLIC_API_TEST=1 node --max-old-space-size=4096 --test apps/quotescout/tests/sandbox.test.mjs
test('opt-in: every shipped premium matches the premium CMS published', { skip: process.env.QUOTESCOUT_PUBLIC_API_TEST !== '1' }, async (t) => {
  const { unzipSingle, eachRow, PUF } = await import('../../../scripts/build-quotescout-data.mjs');
  const { getMeta, plansFor, resolveZip, stateOfFips } = await import('../../../netlify/functions/lib/quotescout/marketplace.mjs');
  const zlib = await import('node:zlib');
  const fs = await import('node:fs');
  const meta = getMeta();

  const response = await fetch(`${PUF(meta.planYear)}rate-puf.zip`);
  assert.ok(response.ok, `CMS returned ${response.status} for the plan year ${meta.planYear} Rate PUF`);
  const csv = unzipSingle(Buffer.from(await response.arrayBuffer()));

  // plan|area|age -> [rate, tobaccoRate], straight from the published file.
  const published = new Map();
  let iPlan = -1, iArea = -1, iAge = -1, iRate = -1, iTobacco = -1;
  eachRow(csv, header => {
    iPlan = header.indexOf('PlanId'); iArea = header.indexOf('RatingAreaId'); iAge = header.indexOf('Age');
    iRate = header.indexOf('IndividualRate'); iTobacco = header.indexOf('IndividualTobaccoRate');
    assert.ok([iPlan, iArea, iAge, iRate, iTobacco].every(i => i >= 0), 'Rate PUF columns changed');
  }, line => {
    const r = line.split(',');
    const age = r[iAge] === '64 and over' ? '64' : r[iAge];
    published.set(`${r[iPlan]}|${r[iArea]}|${age}`, [r[iRate], r[iTobacco]]);
  });
  assert.ok(published.size > 100000, `expected a full Rate PUF, saw ${published.size} rows`);

  const zips = JSON.parse(zlib.gunzipSync(fs.readFileSync(new URL('../../../netlify/functions/lib/quotescout/data/zips.json.gz', import.meta.url))));
  let checked = 0;
  const mismatches = [];
  for (const state of meta.states) {
    const zip = Object.keys(zips).find(z => stateOfFips(zips[z][0]) === state && resolveZip(z)?.length === 1);
    assert.ok(zip, `no single-county ZIP found for ${state}`);
    const fips = zips[zip][0];
    for (const age of [18, 21, 30, 45, 60, 64]) {
      for (const tobacco of [false, true]) {
        for (const dental of [false, true]) {
          const found = plansFor({ state, fips, zip, age, tobacco, dental });
          for (const plan of (found?.plans || []).slice(0, 8)) {
            const row = published.get(`${plan.id}|Rating Area ${plan.ratingArea}|${age}`);
            checked++;
            if (!row) { mismatches.push(`${plan.id} area ${plan.ratingArea} age ${age}: absent from the published file`); continue; }
            const expected = Math.round(Number(tobacco && plan.tobaccoRated ? row[1] : row[0]) * 100);
            if (expected !== plan.premium) mismatches.push(`${plan.id} age ${age} tobacco=${tobacco}: shipped ${plan.premium}, published ${expected}`);
          }
        }
      }
    }
  }
  t.diagnostic(`compared ${checked} premiums across ${meta.states.length} states`);
  assert.ok(checked > 1000, `expected a broad sample, compared only ${checked}`);
  assert.deepEqual(mismatches.slice(0, 10), [], `${mismatches.length} shipped premiums disagree with CMS`);
});
