// Every price in this file is real adapter output over a real ZIP, generated
// here and replayed through CDP, so the browser exercises the production
// normalizer rather than a hand-written number.
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { newPage, closePage, goto, evaluate, evalAsync, setValue, setViewport, clickSel, waitForExpr, interceptNetwork, screenshot, cleanErrors } from '../../../tests/browser/cdp.mjs';
import { VERTICALS } from '../js/model.js';
import { marketplaceQuotes, medicareQuotes } from '../../../netlify/functions/lib/quotescout/adapters.mjs';
import { getMeta } from '../../../netlify/functions/lib/quotescout/marketplace.mjs';

export async function run({ base, cdpPort }) {
  const R = [], t = (name, pass, detail = '') => R.push({ name: `Quote Scout ${name}`, pass: !!pass, detail });
  const s = await newPage(cdpPort);
  const requests = [];
  let scenario = 'ok';
  const meta = getMeta();
  const TTL = 6 * 3600000;
  const capabilities = {
    vehicleData: true,
    planYear: meta.planYear,
    states: meta.states,
    dataPublishedAt: meta.pufImportDate,
    medicare: { year: meta.planYear, states: meta.medicare.states, publishedAt: meta.medicare.publishedAt },
    verticals: VERTICALS.map(v => ({ ...v, capability: 'Public data', sources: [] })),
  };
  const health = () => marketplaceQuotes({ zip: '78701', age: 40, tobacco: false, year: meta.planYear }, { now: Date.now(), ttl: TTL });
  const advantage = () => medicareQuotes({ zip: '78701' }, { provider: 'medicare-advantage', now: Date.now(), ttl: TTL });
  const wire = events => ({ contentType: 'application/x-ndjson', body: events.map(e => JSON.stringify(e)).join('\n') + '\n' });

  await interceptNetwork(s, (url, req) => {
    if (/firestore|firebaseio|identitytoolkit|securetoken/.test(url)) return 'fail';
    if (!url.includes('/.netlify/functions/quotescout')) return null;
    if (req.method === 'GET') return { body: capabilities };
    const body = JSON.parse(req.postData); requests.push(body);
    if (scenario === 'error') return { status: 429, body: { message: 'The comparison limit has been reached. Please try again later.' } };
    const start = { type: 'start', providers: [{ id: 'fixture', enabled: true }] }, done = { type: 'done', checked: 1 };
    if (body.vertical === 'vehicle-data') return wire([start, { type: 'provider', provider: 'vpic', name: 'NHTSA vPIC', enabled: true, status: 'OK', quotes: [], vehicle: { year: '2003', make: 'HONDA', model: 'Accord', source: 'NHTSA vPIC (TEST FIXTURE)', warning: 'TEST DATA' } }, done]);
    if (body.vertical === 'medicare-advantage') {
      const r = advantage();
      return wire([start, { type: 'provider', provider: 'medicare-advantage', name: 'CMS Medicare plan data', enabled: true, status: 'OK', quotes: r.quotes, warning: r.warning, cached: false }, { ...done, returned: r.quotes.length, unavailable: 0, additional: 0 }]);
    }
    if (body.vertical === 'health-insurance' && scenario === 'question' && !body.input.county) {
      return wire([start, { type: 'provider', provider: 'cms-puf', name: 'CMS Marketplace plan data', enabled: true, status: 'ADDITIONAL', quotes: [], questions: [{ field: 'county', label: 'Which county?', options: [{ value: '37057', label: 'TEST Davidson' }, { value: '37081', label: 'TEST Guilford' }] }] }, done]);
    }
    if (body.vertical === 'health-insurance' && scenario === 'question') {
      return wire([start, { type: 'provider', provider: 'cms-puf', name: 'CMS Marketplace plan data', enabled: true, status: 'UNSUPPORTED', quotes: [], message: 'No plans for this location.' }, done]);
    }
    const r = health();
    return wire([start, { type: 'provider', provider: 'cms-puf', name: 'CMS Marketplace plan data', enabled: true, status: 'OK', quotes: r.quotes, warning: r.warning, cached: requests.length > 3 }, { ...done, returned: r.quotes.length, unavailable: 0, additional: 0 }]);
  });

  try {
    await setViewport(s, 1280, 900);
    await goto(s, base + '/apps/quotescout/', { settle: 800 });
    await waitForExpr(s, "!document.getElementById('qs-form').hidden");

    // The page must open on something that returns a price.
    t('opens on a real comparison, not the vehicle decoder', await evaluate(s, "document.getElementById('qs-category').value==='health-insurance'"));
    t('the vehicle decoder is still offered, last', await evaluate(s, "[...document.getElementById('qs-category').options].at(-1).value==='vehicle-data'"));
    t('every offered category is live', await evaluate(s, "[...document.getElementById('qs-category').options].every(o=>/Public data|NHTSA data/.test(o.textContent))"));
    t('no dead-end categories are advertised', await evaluate(s, "document.getElementById('qs-unavailable-panel').hidden===true"));
    t('no email or phone gate', await evaluate(s, "!document.querySelector('#quotescout input[type=email],#quotescout input[type=tel]')"));
    t('coverage of both datasets is stated up front', await evaluate(s, "/HealthCare.gov/.test(document.getElementById('qs-coverage').textContent) && /Medicare/.test(document.getElementById('qs-coverage').textContent)"));

    // ---- health: published marketplace rates
    t('health asks only what it cannot derive', await evaluate(s, "[...document.querySelectorAll('#qs-fields input,#qs-fields select')].map(f=>f.name).join()==='zip,age,tobacco'"));
    for (const [k, v] of Object.entries({ zip: '78701', age: '40', tobacco: 'false' })) await setValue(s, `#qs-${k}`, v);
    await clickSel(s, '#qs-submit');
    await waitForExpr(s, "document.querySelectorAll('.qs-result').length>0");
    t('Top 3 rather than every plan', await evaluate(s, "document.querySelectorAll('.qs-result').length===3"));
    t('published rates render as real prices', await evaluate(s, "[...document.querySelectorAll('.qs-result .qs-price')].every(p=>/^\\$[0-9,]+\\.[0-9]{2} \\/ month$/.test(p.textContent))"));
    t('labelled a published rate, not a verified quote', await evaluate(s, "[...document.querySelectorAll('.qs-badge')].every(b=>b.textContent==='Published rate')"));
    t('freshness is the dataset vintage, not a retrieval time', await evaluate(s, `document.querySelector('.qs-result .qs-muted').textContent.startsWith('Plan year ${meta.planYear} rate, published by CMS on ') && !document.getElementById('qs-results').textContent.includes('seconds ago')`));
    t('deductible and out-of-pocket are shown', await evaluate(s, "document.querySelector('.qs-result').textContent.includes('Max out-of-pocket')"));
    t('age-restricted catastrophic plans are excluded and said so', await evaluate(s, "document.getElementById('qs-results').textContent.includes('catastrophic plan')"));
    t('the source is named on the card', await evaluate(s, "document.querySelector('.qs-result details').textContent.includes('Public Use Files')"));
    t('the plan year still reaches the backend', requests.at(-1).input.year === meta.planYear);
    t('the handoff only points at HealthCare.gov', await evaluate(s, "[...document.querySelectorAll('.qs-result a')].every(a=>a.href==='https://www.healthcare.gov/see-plans/'&&a.rel.includes('noreferrer'))"));

    await evaluate(s, "Array.from(document.querySelectorAll('#qs-results button')).find(b=>b.textContent.includes('See all'))?.click()");
    t('all results expand', await evaluate(s, "document.querySelectorAll('.qs-result').length>3"));
    await setValue(s, '#qs-mode', 'best-value');
    t('ranking explains its tradeoff', await evaluate(s, "document.getElementById('qs-results').textContent.includes('not expected annual spending')"));

    await mkdir(new URL('../.reports/', import.meta.url), { recursive: true });
    await screenshot(s, new URL('../.reports/desktop-results.png', import.meta.url).pathname);

    await clickSel(s, '#qs-refresh');
    await waitForExpr(s, "!document.getElementById('qs-refresh').disabled");
    t('refresh explicitly requests new prices', requests.at(-1).refresh === true);
    await clickSel(s, '#qs-modify');
    t('modify focuses the first field', await evaluate(s, "document.activeElement.id==='qs-zip'"));

    // ---- medicare: a ZIP is the whole of the input
    await setValue(s, '#qs-category', 'medicare-advantage');
    await evaluate(s, "document.getElementById('qs-category').dispatchEvent(new Event('change'))");
    t('Medicare asks for a ZIP and nothing else', await evaluate(s, "[...document.querySelectorAll('#qs-fields input,#qs-fields select')].map(f=>f.name).join()==='zip'"));
    await setValue(s, '#qs-zip', '78701');
    await clickSel(s, '#qs-submit');
    await waitForExpr(s, "document.querySelectorAll('.qs-result').length>0");
    t('Medicare returns real published premiums', await evaluate(s, "[...document.querySelectorAll('.qs-result .qs-price')].every(p=>/^\\$[0-9,]+\\.[0-9]{2} \\/ month$/.test(p.textContent))"));
    t('a zero-premium plan says Part B is separate on the card face', await evaluate(s, "[...document.querySelectorAll('.qs-result')].every(c=>c.querySelector('.qs-note')?.textContent.includes('Part B premium you pay Medicare separately'))"));
    t('the Part B caveat is not only in the disclosure', await evaluate(s, "document.querySelector('.qs-result .qs-note')!==null"));
    t('CMS star ratings are shown', await evaluate(s, "/CMS star rating: [0-9.]+ out of 5|Not rated by CMS/.test(document.querySelector('.qs-result').textContent)"));
    t('the Medicare handoff points at Medicare.gov', await evaluate(s, "[...document.querySelectorAll('.qs-result a')].every(a=>a.href==='https://www.medicare.gov/plan-compare/')"));
    await setValue(s, '#qs-mode', 'best-rated');
    t('best rated explains it is not a recommendation', await evaluate(s, "document.getElementById('qs-results').textContent.includes('not whether the plan suits you')"));

    const axe = await readFile(new URL('../../../tests/browser/vendor/axe.min.js', import.meta.url), 'utf8');
    await s.send('Runtime.evaluate', { expression: axe });
    const violations = await evalAsync(s, "axe.run(document.getElementById('quotescout'),{runOnly:{type:'tag',values:['wcag2a','wcag2aa','wcag21aa']}}).then(r=>r.violations.map(v=>({id:v.id,nodes:v.nodes.map(n=>n.target)})))");
    t('results accessibility', Array.isArray(violations) && violations.length === 0, JSON.stringify(violations));

    // ---- vehicle decoder still works, and is still only a decoder
    await clickSel(s, '#qs-modify');
    await setValue(s, '#qs-category', 'vehicle-data');
    await evaluate(s, "document.getElementById('qs-category').dispatchEvent(new Event('change'))");
    t('minimum VIN form', await evaluate(s, "document.querySelectorAll('#qs-fields input').length===1"));
    const before = requests.length;
    await setValue(s, '#qs-vin', 'bad'); await clickSel(s, '#qs-submit');
    t('invalid input does not call the API', requests.length === before);
    await setValue(s, '#qs-vin', '1HGCM82633A004352'); await clickSel(s, '#qs-submit');
    await waitForExpr(s, "document.getElementById('qs-results').textContent.includes('HONDA')");
    t('vehicle decode renders', true);
    t('vehicle data is never priced', await evaluate(s, "!document.querySelector('.qs-price')"));

    // ---- progressive county question
    scenario = 'question';
    await clickSel(s, '#qs-modify');
    await setValue(s, '#qs-category', 'health-insurance');
    await evaluate(s, "document.getElementById('qs-category').dispatchEvent(new Event('change'))");
    for (const [k, v] of Object.entries({ zip: '27360', age: '27', tobacco: 'false' })) await setValue(s, `#qs-${k}`, v);
    t('county not initially requested', await evaluate(s, "!document.querySelector('[name=county]')"));
    await clickSel(s, '#qs-submit');
    await waitForExpr(s, "!!document.querySelector('[name=county]')");
    t('provider question appears progressively', true);
    await setValue(s, '[name=county]', '37057');
    await clickSel(s, '.qs-question button');
    await waitForExpr(s, "document.getElementById('qs-results').textContent.includes('No plans')");
    t('the answer only targets the asking provider', requests.at(-1).provider === 'cms-puf' && requests.at(-1).input.county === '37057');
    t('an empty result explains that nothing is guessed', await evaluate(s, "document.getElementById('qs-results').textContent.includes('guessed prices')"));

    // ---- mobile and shared-CSS resistance
    await setViewport(s, 390, 844);
    await evaluate(s, 'window.scrollTo(0,0)');
    await screenshot(s, new URL('../.reports/mobile.png', import.meta.url).pathname);
    t('mobile no horizontal overflow', await evaluate(s, 'document.documentElement.scrollWidth<=390'));
    t('button colors resist shared CSS', await evaluate(s, "getComputedStyle(document.getElementById('qs-submit')).color==='rgb(16, 35, 53)'"));

    scenario = 'error';
    await setViewport(s, 1280, 900);
    await clickSel(s, '#qs-refresh');
    await waitForExpr(s, "document.getElementById('qs-error').textContent.includes('limit')");
    t('rate limit is actionable', true);
    t('no persistent quote data', await evaluate(s, "!Object.keys(localStorage).some(k=>/quotescout/.test(k))"));
    t('no uncaught JS errors', cleanErrors(s).length === 0, JSON.stringify(cleanErrors(s)));
  } catch (e) {
    t('flow completes', false, String(e.stack || e));
  } finally {
    await closePage(cdpPort, s);
  }
  return R;
}
