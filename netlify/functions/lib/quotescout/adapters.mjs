import { upstream } from './http.mjs';
import { ScoutError } from './validation.mjs';
const text = (v, max = 160) => typeof v === 'string' && v.length > 0 && v.length <= max && !/[\x00-\x1f]/.test(v) ? v : null;
export function cents(v) {
  if (!['number','string'].includes(typeof v) || !/^\d+(\.\d{1,2})?$/.test(String(v))) return null;
  const amount = Math.round(Number(v) * 100);
  return Number.isSafeInteger(amount) && amount <= 100000000 ? amount : null;
}
const required = v => { if (v === null || v === undefined) throw new ScoutError('MALFORMED'); return v; };
function base(provider, vertical, id, amount, now, ttl, product, warning) {
  return { id: `${provider}:${id}`, provider, vertical, amount, currency: 'USD', status: 'ESTIMATE',
    retrievedAt: new Date(now).toISOString(), expiresAt: new Date(now + ttl).toISOString(),
    provenance: { source: provider === 'cms' ? 'CMS Marketplace API' : 'EasyPost Rates API', sourceId: id, kind: 'provider-estimate', transformations: ['USD decimal to integer cents'], product, checkoutExact: false, warning },
  };
}
export function normalizeEasyPost(data, input, now) {
  if (!Array.isArray(data.rates) || data.rates.length > 200) throw new ScoutError('MALFORMED');
  let rejected = 0;
  const quotes = data.rates.flatMap((r, index) => {
    try {
      if (r.mode !== 'production' || r.currency !== 'USD') throw new ScoutError('MALFORMED');
      const amount = required(cents(r.rate)), carrier = required(text(r.carrier)), service = required(text(r.service));
      const q = base('easypost', 'package-shipping', `${carrier}:${service}:${index}`, amount, now, 5 * 60000,
        { ...input, weightUnit: 'oz', dimensionUnit: 'in', carrier, service },
        'Account-specific carrier rate estimate. QuoteScout does not sell labels. This price may not be available on the carrier website; final address, measurements, surcharges and account terms can change it.');
      const guarantee = r.delivery_date_guaranteed === true;
      return [{ ...q, name: service, providerName: carrier, interval: 'shipment',
        comparisonKey: `package:${guarantee ? 'guaranteed' : 'estimated'}:insurance-unknown`, comparisonLabel: `${guarantee ? 'Guaranteed delivery date' : 'Estimated delivery'} · Insurance not confirmed`,
        deliveryDays: Number.isInteger(r.delivery_days) && r.delivery_days >= 0 && r.delivery_days < 366 ? r.delivery_days : null,
        details: { Service: service, 'Delivery date': text(r.delivery_date) || 'Not reported', 'Delivery guarantee': guarantee ? 'Provider reports guaranteed' : 'Not guaranteed', Insurance: 'Not reported; not included in comparison', Tracking: 'Confirm when purchasing a label' },
      }];
    } catch { rejected++; return []; }
  });
  return { quotes, rejected, warning: Array.isArray(data.messages) && data.messages.length ? 'Some carriers did not return rates.' : null };
}
function individualCost(rows, types) {
  if (!Array.isArray(rows)) return null;
  const matches = rows.filter(r => r.family_cost === 'Individual' && r.network_tier === 'In-Network' && types.includes(r.type));
  // Ambiguous tiers/CSR must not be collapsed into the cheapest deductible.
  return matches.length === 1 ? cents(matches[0].amount) : null;
}
export function normalizeCMS(data, input, place, now) {
  if (!Array.isArray(data.plans) || data.plans.length > 500) throw new ScoutError('MALFORMED');
  let rejected = 0;
  const quotes = data.plans.flatMap(p => {
    if (p.is_ineligible === true || p.product_division === 'Dental') return [];
    try {
      const id = required(text(p.id)), name = required(text(p.name)), issuer = required(text(p.issuer?.name)), metal = required(text(p.metal_level)), type = required(text(p.type)), amount = required(cents(p.premium));
      const deductible = individualCost(p.deductibles, ['Combined Medical and Drug EHB Deductible', 'Medical EHB Deductible']);
      const outOfPocket = individualCost(p.moops, ['Maximum Out of Pocket for Medical and Drug EHB Benefits (Total)']);
      const q = base('cms', 'health-insurance', id, amount, now, 15 * 60000,
        { age: input.age, tobacco: input.tobacco, year: input.year, place, people: 1, subsidies: false, metal, planType: type },
        'CMS premium estimate for one adult, before tax credits. Eligibility, enrollment date, tobacco rating and final application can change the premium. QuoteScout does not enroll or broker insurance.');
      q.provenance.transformations.push('Monthly premium × 12 for annual premium');
      const rating = p.quality_rating?.available && Number.isInteger(p.quality_rating.global_rating) && p.quality_rating.global_rating > 0 && p.quality_rating.global_rating <= 5 ? `${p.quality_rating.global_rating}/5 (${p.quality_rating.year || 'year not reported'})` : 'Not rated';
      return [{ ...q, name, providerName: issuer, interval: 'month', annual: amount * 12, deductible, outOfPocket,
        // Individual networks remain materially different even within a metal/type group.
        comparisonKey: `health:${metal}:${type}`, comparisonLabel: `${metal} · ${type} (networks and benefits differ)`,
        details: { 'Metal level': metal, 'Plan type': type, Network: 'Confirm your doctors with the insurer; networks differ by plan', 'Quality rating': rating, 'Coverage year': String(input.year), Subsidies: 'Not calculated', 'Drug coverage': 'Confirm your medicines in the plan formulary', 'Deductible basis': 'Individual, in-network medical (may exclude drugs)' },
        continueUrl: 'https://www.healthcare.gov/see-plans/', continueLabel: 'Review plans on HealthCare.gov', affiliate: false,
      }];
    } catch { rejected++; return []; }
  });
  return { quotes, rejected, warning: Number.isFinite(data.total) && data.total > data.plans.length ? `Showing ${data.plans.length} plans returned by CMS, out of ${data.total}. These are not a complete market ranking.` : null };
}
export function createAdapters(config = {}, fetcher = fetch, now = Date.now) {
  const cmsURL = path => `https://marketplace.api.healthcare.gov/api/v1/${path}${path.includes('?') ? '&' : '?'}apikey=${encodeURIComponent(config.cmsKey)}`;
  return [
    { id: 'easypost', name: 'EasyPost', vertical: 'package-shipping', enabled: !!config.easypostKey, ttl: 300000,
      async quote(input, ctx) {
        const data = await upstream('https://api.easypost.com/beta/rates', { ...ctx, fetcher, method: 'POST', headers: { Authorization: `Basic ${Buffer.from(`${config.easypostKey}:`).toString('base64')}`, 'Content-Type': 'application/json' }, body: { shipment: { from_address: { zip: input.originZip, country: 'US' }, to_address: { zip: input.destinationZip, country: 'US' }, parcel: { weight: input.weight, length: input.length, width: input.width, height: input.height }, carrier_accounts: config.carrierAccounts } } });
        return normalizeEasyPost(data, input, now());
      } },
    { id: 'cms', name: 'CMS Marketplace', vertical: 'health-insurance', enabled: !!config.cmsKey, ttl: 900000,
      async quote(input, ctx) {
        const data = await ctx.enrich(`county:${input.year}:${input.zip}`, 86400000, () => upstream(cmsURL(`counties/by/zip/${input.zip}?year=${input.year}`), { ...ctx, fetcher }));
        if (!Array.isArray(data.counties) || data.counties.length > 30 || data.counties.some(c => !/^\d{5}$/.test(c.fips) || !/^[A-Z]{2}$/.test(c.state) || !text(c.name))) throw new ScoutError('MALFORMED');
        if (!data.counties.length) throw new ScoutError('UNSUPPORTED');
        const county = input.county ? data.counties.find(c => c.fips === input.county) : data.counties.length === 1 ? data.counties[0] : null;
        if (input.county && !county) throw new ScoutError('INVALID_INPUT');
        if (!county) return { quotes: [], questions: [{ field: 'county', label: 'Your ZIP includes more than one county. CMS needs your county to find the right plans.', options: data.counties.map(c => ({ value: c.fips, label: `${c.name}, ${c.state}` })) }] };
        const place = { countyfips: county.fips, state: county.state, zipcode: input.zip };
        const plans = await upstream(cmsURL('plans/search'), { ...ctx, fetcher, method: 'POST', headers: { 'Content-Type': 'application/json' }, body: { place, year: input.year, market: 'Individual', sort: 'premium', order: 'asc', household: { people: [{ age: input.age, uses_tobacco: input.tobacco, aptc_eligible: false }] }, aptc_override: 0 } });
        return normalizeCMS(plans, input, place, now());
      } },
    { id: 'vpic', name: 'NHTSA vPIC', vertical: 'vehicle-data', enabled: true, ttl: 900000,
      async quote(input, ctx) {
        const data = await ctx.enrich(`vin:${input.vin}`, 30 * 86400000, () => upstream(`https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVinValues/${input.vin}?format=json`, { ...ctx, fetcher }));
        const v = data.Results?.[0];
        if (!v || !text(v.Make) || !text(v.Model) || !/^\d{4}$/.test(v.ModelYear)) throw new ScoutError('UNSUPPORTED');
        if (typeof v.ErrorCode !== 'string' || v.ErrorCode.split(',').some(c => c.trim() !== '0')) throw new ScoutError('UNSUPPORTED');
        return { quotes: [], vehicle: { make: v.Make, model: v.Model, year: v.ModelYear, trim: text(v.Trim), body: text(v.BodyClass), engine: text(v.EngineModel), fuel: text(v.FuelTypePrimary), source: 'NHTSA vPIC manufacturer-reported data', warning: 'Decoded specifications are not a title, history, recall or insurance-eligibility check.' } };
      } },
  ];
}
