import { VERTICALS, MODE_LABELS, STATUS_LABELS, STATUS_MEANING, rankQuotes, money, isFresh, freshness } from './model.js';
const $ = id => document.getElementById(id);
const root = $('quotescout');
const endpoint = '/.netlify/functions/quotescout';
const session = [...crypto.getRandomValues(new Uint8Array(32))].map(v => v.toString(16).padStart(2,'0')).join('');
let capabilities = [], current = 'vehicle-data', providers = [], quotes = [], inputSnapshot, controller, generation = 0, showingAll = false, selectedGroup = '', loading = false;
let service = {};
const MARKETPLACE = ['health-insurance', 'dental-insurance'];
const count = (n, noun) => `${n} ${noun}${n === 1 ? '' : 's'}`;
const el = (tag, text, className) => { const n = document.createElement(tag); if (text !== undefined) n.textContent = text; if (className) n.className = className; return n; };
function field(name, label, options = {}) {
  const wrap = el('div', undefined, 'qs-field'); const lab = el('label', label); lab.htmlFor = `qs-${name}`;
  const n = options.choices ? el('select') : el('input'); n.id = `qs-${name}`; n.name = name; n.required = true;
  if (options.choices) for (const [value, title] of options.choices) { const option = el('option', title); option.value = value; n.append(option); }
  else { n.type = options.type || 'text'; n.autocomplete = options.autocomplete || 'off'; for (const key of ['min','max','step','pattern','inputMode','maxLength']) if (options[key] !== undefined) n[key] = options[key]; }
  wrap.append(lab, n);
  if (options.help) { const help = el('small', options.help); help.id = `qs-${name}-help`; n.setAttribute('aria-describedby', help.id); wrap.append(help); }
  $('qs-fields').append(wrap); return n;
}
function choose(id) {
  generation++; controller?.abort(); loading = false; current = id; quotes = []; providers = []; inputSnapshot = null; selectedGroup = ''; showingAll = false;
  $('qs-results').removeAttribute('aria-busy'); $('qs-results').replaceChildren(); $('qs-progress').textContent = ''; $('qs-error').textContent = ''; $('qs-fields').replaceChildren(); $('qs-submit').disabled = false;
  const v = VERTICALS.find(v => v.id === id); $('qs-form-title').textContent = v?.name || 'Decode your vehicle';
  $('qs-submit').textContent = id === 'vehicle-data' ? 'Decode VIN' : 'Compare options';
  const marketplaceNote = `One adult, ages 18-64, for plan year ${service.planYear || ''}. These are the full premiums insurers filed with the government, before any premium tax credit. Available in the ${(service.states || []).length} states whose marketplace runs on HealthCare.gov.`;
  $('qs-form-note').textContent = id === 'vehicle-data' ? 'Manufacturer-reported vehicle details from NHTSA. No quote or vehicle-history claims.' : id === 'package-shipping' ? 'US domestic packages. Account-specific estimates, not labels for purchase. Carriers may require a full address before providing a rate.' : MARKETPLACE.includes(id) ? marketplaceNote : '';
  $('qs-transmission').textContent = id === 'vehicle-data' ? 'On submit: your VIN goes to the Shevato backend and NHTSA vPIC.' : id === 'package-shipping' ? 'On submit: ZIPs and package measurements go to the Shevato backend, EasyPost and the configured carriers needed to rate your shipment.' : MARKETPLACE.includes(id) ? 'On submit: your ZIP, age, tobacco status and coverage year go to the Shevato backend only. The published rates are held on our server, so nothing about your search is sent to an insurer or any other company.' : '';
  $('qs-mode').replaceChildren(); for (const mode of v?.modes || ['cheapest']) { const o = el('option', MODE_LABELS[mode]); o.value = mode; $('qs-mode').append(o); }
  $('qs-mode').value = 'cheapest';
  if (id === 'vehicle-data') field('vin', 'VIN', { maxLength: 17, pattern: '[A-HJ-NPR-Za-hj-npr-z0-9]{17}', help: '17 characters, usually on the dashboard or vehicle registration.' });
  if (id === 'package-shipping') {
    field('originZip', 'From ZIP', { inputMode: 'numeric', pattern: '[0-9]{5}', maxLength: 5, autocomplete: 'section-origin postal-code' });
    field('destinationZip', 'To ZIP', { inputMode: 'numeric', pattern: '[0-9]{5}', maxLength: 5, autocomplete: 'section-destination postal-code' });
    field('weight', 'Weight (ounces)', { type: 'number', min: .01, max: 1120, step: .01, help: 'Include packaging. 16 ounces = 1 pound.' });
    for (const k of ['length','width','height']) field(k, `${k[0].toUpperCase()+k.slice(1)} (inches)`, { type: 'number', min: .01, max: 108, step: .01 });
  }
  if (MARKETPLACE.includes(id)) {
    field('zip', 'ZIP code', { inputMode: 'numeric', pattern: '[0-9]{5}', maxLength: 5, autocomplete: 'postal-code', help: 'Premiums are set by county, so we may ask which county if your ZIP covers more than one.' });
    field('age', 'Age during coverage year', { type: 'number', min: 18, max: 64, step: 1 });
    field('tobacco', 'Do you use tobacco?', { choices: [['','Choose'],['false','No'],['true','Yes']], help: 'Some insurers file one rate either way; the result says which applied.' });
    // The coverage year is not a question: we hold exactly one plan year, the
    // note above says which, and every result repeats it. Asking would be a
    // field with a single answer.
  }
  $('qs-form').hidden = false; $('qs-controls').hidden = true;
}
const AVAILABLE = ['Public data', 'Beta'];
function showCapabilities(data) {
  capabilities = data.verticals || []; service = data; const select = $('qs-category'); select.replaceChildren();
  if (data.vehicleData) { const o = el('option', 'Vehicle details · NHTSA data'); o.value = 'vehicle-data'; select.append(o); }
  for (const v of capabilities.filter(v => AVAILABLE.includes(v.capability))) { const o = el('option', `${v.name} · ${v.capability}`); o.value = v.id; select.append(o); }
  const unavailable = $('qs-unavailable'); unavailable.replaceChildren();
  for (const v of capabilities.filter(v => !AVAILABLE.includes(v.capability))) { const row = el('p'); row.append(el('strong', `${v.name}: `), document.createTextNode(v.reason)); unavailable.append(row); }
  // State the coverage limit up front rather than after someone types a ZIP we
  // cannot answer for.
  const states = data.states || [];
  $('qs-coverage').textContent = states.length
    ? `Health and dental plan prices are the rates insurers filed for plan year ${data.planYear}, published by CMS on ${new Date(`${data.dataPublishedAt}T00:00:00Z`).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' })}. They cover the ${states.length} states that use HealthCare.gov: ${states.join(', ')}. States running their own marketplace are not included.`
    : '';
  if (select.options.length) { choose(select.value); $('qs-service-error').hidden = true; }
  else { $('qs-form').hidden = true; $('qs-service-error').hidden = false; }
  select.disabled = !select.options.length;
}
function readInput() {
  const raw = Object.fromEntries(new FormData($('qs-form')));
  for (const k of ['weight','length','width','height','age','year']) if (k in raw) raw[k] = Number(raw[k]);
  if ('tobacco' in raw) raw.tobacco = raw.tobacco === 'true';
  if ('vin' in raw) raw.vin = raw.vin.trim().toUpperCase();
  return raw;
}
async function compare({ refresh = false, provider, input = readInput() } = {}) {
  // Supplied rather than asked for; see choose().
  if (MARKETPLACE.includes(current) && input.year === undefined) input.year = service.planYear || new Date().getUTCFullYear();
  controller?.abort(); const run = ++generation; controller = new AbortController(); const activeController = controller; loading = true;
  inputSnapshot = structuredClone(input); showingAll = false;
  if (provider) { providers = providers.filter(p => p.provider !== provider); quotes = quotes.filter(q => q.provider !== provider); }
  else { providers = []; quotes = []; selectedGroup = ''; }
  $('qs-submit').disabled = true; $('qs-refresh').disabled = true; $('qs-error').textContent = ''; $('qs-progress').textContent = current === 'vehicle-data' ? 'Checking vehicle information with NHTSA…' : 'Finding available options…';
  $('qs-form').hidden = true;
  $('qs-results').setAttribute('aria-busy','true'); renderResults();
  const timer = setTimeout(() => activeController.abort(), 30000);
  try {
    const r = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-QuoteScout-Session': session }, body: JSON.stringify({ vertical: current, input, refresh, ...(provider ? { provider } : {}) }), signal: activeController.signal, cache: 'no-store' });
    if (!r.ok) {
      const error = await r.json().catch(() => ({}));
      if (run !== generation) return;
      const invalid = $(`qs-${error.field}`); if (invalid) { invalid.setAttribute('aria-invalid','true'); invalid.setAttribute('aria-errormessage','qs-error'); invalid.focus(); }
      throw new Error(error.message || 'Comparison is unavailable. Please try again.');
    }
    if (!r.headers.get('content-type')?.includes('application/x-ndjson')) throw new Error('Comparison service is unavailable. Please try again.');
    const reader = r.body.getReader(), decoder = new TextDecoder(); let buffer = '', doneEvent = false, bytes = 0;
    while (true) {
      const { value, done } = await reader.read(); if (done) break; if (run !== generation) { await reader.cancel(); return; }
      bytes += value.length; if (bytes > 2500000) { await reader.cancel(); throw new Error('Comparison response was too large. Please try again.'); }
      buffer += decoder.decode(value, { stream: true });
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const event = JSON.parse(buffer.slice(0,newline)); buffer = buffer.slice(newline+1);
        if (event.type === 'start') { const n = event.providers.filter(p => p.enabled).length; $('qs-progress').textContent = `Checking ${n} data source${n === 1 ? '' : 's'}…`; }
        if (event.type === 'provider') {
          providers.push(event); quotes.push(...event.quotes); renderResults();
          const finished = providers.filter(p => p.enabled !== false).length;
          $('qs-progress').textContent = `${count(finished, 'data source')} finished. ${count(quotes.length, 'option')} returned.`;
        }
        // The server's own tally, so the summary can never drift from what the
        // engine actually did. Clauses worth nothing are left out rather than
        // padded with zeroes.
        if (event.type === 'done') {
          doneEvent = true;
          const parts = [`${count(event.checked, 'data source')} checked`, `${count(quotes.length, 'option')} returned`];
          if (event.unavailable) parts.push(`${event.unavailable} unavailable`);
          if (event.additional) parts.push(`${event.additional} need a detail`);
          $('qs-progress').textContent = parts.join(' \u00b7 ');
        }
        if (event.type === 'error') throw new Error(event.message);
      }
    }
    if (!doneEvent) throw new Error('The connection ended early. Returned options are shown; refresh to try again.');
  } catch (e) {
    if (run === generation) { $('qs-error').textContent = e.name === 'AbortError' ? 'Comparison timed out. Please try again.' : e.message; $('qs-progress').textContent = quotes.length ? 'Partial results are available.' : 'Comparison did not finish.'; }
  } finally {
    clearTimeout(timer);
    if (run === generation) { loading = false; $('qs-results').removeAttribute('aria-busy'); $('qs-submit').disabled = false; $('qs-refresh').disabled = false; renderResults();
      if (!quotes.length && !providers.some(p => p.vehicle || p.questions?.length)) $('qs-form').hidden = false;
      else { const target = $('qs-results').querySelector('select') || $('qs-results'); target.focus(); }
    }
  }
}
function renderResults() {
  const container = $('qs-results'); container.replaceChildren(); $('qs-controls').hidden = !inputSnapshot;
  $('qs-rank-control').hidden = !quotes.length;
  for (const p of providers) {
    if (p.vehicle) {
      const box = el('section', undefined, 'qs-result'); box.append(el('h3', `${p.vehicle.year} ${p.vehicle.make} ${p.vehicle.model}`), el('p', p.vehicle.source));
      const list = el('dl'); for (const key of ['trim','body','engine','fuel']) { list.append(el('dt',key[0].toUpperCase()+key.slice(1)),el('dd',p.vehicle[key] || 'Not reported')); } if (p.vehicle.retrievedAt) box.append(el('p', `Retrieved ${new Date(p.vehicle.retrievedAt).toLocaleString()}`, 'qs-muted')); box.append(list,el('p',p.vehicle.warning)); container.append(box);
    }
    if (p.questions?.length) {
      const form = el('form', undefined, 'qs-question');
      for (const q of p.questions) {
        const id = `qs-additional-${p.provider}-${q.field}`; const label = el('label',`${p.name}: ${q.label}`); label.htmlFor = id;
        const select = el('select'); select.id = id; select.name = q.field; select.required = true;
        const blank = el('option','Choose your county'); blank.value = ''; select.append(blank);
        for (const option of q.options) { const o = el('option', option.label); o.value = option.value; select.append(o); } form.append(label,select);
      }
      const submit = el('button',`Continue with ${p.name}`); submit.type = 'submit'; submit.disabled = loading; form.append(submit);
      form.addEventListener('submit',e => { e.preventDefault(); compare({ provider: p.provider, input: { ...inputSnapshot, ...Object.fromEntries(new FormData(form)) } }); }); container.append(form);
    }
    // A source that is not connected at all is listed under "Other comparison
    // categories"; repeating it as a failure on every search is just noise.
    if (!['OK','ADDITIONAL'].includes(p.status) && p.enabled !== false) container.append(el('p', `${p.name}: ${p.message || 'No usable options returned for this request.'}`, 'qs-notice'));
    if (p.warning || p.rejected) container.append(el('p', `${p.warning || ''} ${p.rejected ? `${p.rejected} unverified response(s) excluded.` : ''}`, 'qs-notice'));
  }
  if (quotes.length) {
    const groups = rankQuotes(quotes, $('qs-mode').value);
    if (!groups.length) { container.append(el('p','These prices have expired. Refresh prices to compare again.')); return; }
    if (!groups.some(g => g.key === selectedGroup)) selectedGroup = groups[0].key;
    if (groups.length > 1) {
      const label = el('label','Compare a product group'); label.htmlFor = 'qs-group'; const select = el('select'); select.id = 'qs-group';
      for (const g of groups) { const o = el('option',`${g.label} (${g.quotes.length})`); o.value = g.key; select.append(o); } select.value = selectedGroup;
      select.addEventListener('change',() => { selectedGroup = select.value; showingAll = false; renderResults(); });
      container.append(el('p','Products differ. Compare within a group, then review coverage, network and delivery differences.'),label,select);
    }
    const g = groups.find(g => g.key === selectedGroup);
    container.append(el('h3', showingAll ? `All ${g.quotes.length} options in this group` : `Top ${Math.min(3,g.quotes.length)} in this group`), el('p', g.label, 'qs-muted'), el('p', g.reason, 'qs-muted'));
    const list = el('div', undefined, 'qs-results-grid');
    for (const q of (showingAll ? g.quotes : g.quotes.slice(0,3))) list.append(resultCard(q)); container.append(list);
    if (g.quotes.length > 3) { const more = el('button',showingAll ? 'Show top 3' : `See all ${g.quotes.length} options`); more.type = 'button'; more.addEventListener('click',() => { showingAll = !showingAll; renderResults(); }); container.append(more); }
  } else if (!loading && inputSnapshot && !providers.some(p => p.questions?.length || p.vehicle)) container.append(el('p','No prices are available for this request. We never fill gaps with guessed prices.'));
}
function resultCard(q) {
  const card = el('article', undefined, 'qs-result');
  const status = isFresh(q) ? q.status : 'EXPIRED';
  // The badge carries a word, not just a colour, and the meaning sits beside it
  // so nobody has to guess what "published rate" is promising.
  const badge = el('span', STATUS_LABELS[status] || status, 'qs-badge');
  badge.dataset.status = status;
  card.append(badge, el('h4', q.providerName), el('p', q.name), el('p', `${money(q.amount, q.currency)} / ${q.interval}`, 'qs-price'));
  if (q.annual !== undefined) card.append(el('p', `${money(q.annual, q.currency)} a year at this rate`));
  if (q.deliveryDays != null) card.append(el('p', `${q.deliveryDays} estimated transit day(s)`));
  if (q.deductible !== undefined || q.outOfPocket !== undefined) card.append(el('p', `Deductible: ${money(q.deductible)} · Max out-of-pocket: ${money(q.outOfPocket)}`));
  const cached = providers.find(p => p.provider === q.provider)?.cached;
  card.append(el('p', `${freshness(q)}${cached ? ' Served from this session\u2019s cache.' : ''}`, 'qs-muted'));
  const details = el('details'), summary = el('summary', 'Details and price source'), dl = el('dl');
  for (const [key, value] of Object.entries(q.details || {})) dl.append(el('dt', key), el('dd', value));
  details.append(summary, el('p', STATUS_MEANING[status] || ''), dl, el('p', q.provenance.source), el('p', q.provenance.warning), el('p', `Normalization: ${q.provenance.transformations.join('; ')}.`));
  card.append(details);
  if (q.continueUrl === 'https://www.healthcare.gov/see-plans/') { const a = el('a', q.continueLabel); a.href = q.continueUrl; a.rel = 'noopener noreferrer'; a.referrerPolicy = 'no-referrer'; card.append(a); }
  return card;
}
$('qs-category').addEventListener('change', e => choose(e.target.value));
$('qs-form').addEventListener('submit', e => { e.preventDefault(); compare(); });
$('qs-form').addEventListener('input', e => { e.target.removeAttribute('aria-invalid'); });
$('qs-mode').addEventListener('change', renderResults);
$('qs-refresh').addEventListener('click', () => compare({ refresh: true, input: inputSnapshot }));
$('qs-modify').addEventListener('click', () => { generation++; controller?.abort(); loading = false; $('qs-results').removeAttribute('aria-busy'); $('qs-submit').disabled = false; $('qs-refresh').disabled = false; $('qs-form').hidden = false; $('qs-fields').querySelector('input,select')?.focus(); $('qs-form').scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'center' }); });
async function load() { try { const r = await fetch(endpoint, { cache: 'no-store' }); if (!r.ok) throw new Error(); showCapabilities(await r.json()); } catch { showCapabilities({ verticals: VERTICALS.map(v => ({ ...v, capability: 'Requires provider integration' })), vehicleData: false }); } }
$('qs-retry').addEventListener('click',load);
setInterval(() => { if (!loading && quotes.some(q => q.status !== 'EXPIRED' && !isFresh(q))) { quotes = quotes.map(q => isFresh(q) ? q : { ...q,status:'EXPIRED' }); renderResults(); } },15000);
load();
