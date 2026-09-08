import { upstream } from './http.mjs';
import { ScoutError } from './validation.mjs';
import { getMeta, resolveZip, stateOfZip, plansFor, benchmarkSilver } from './marketplace.mjs';
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
        'Account-specific carrier rate estimate. Quote Scout does not sell labels. This price may not be available on the carrier website; final address, measurements, surcharges and account terms can change it.');
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
        'CMS premium estimate for one adult, before tax credits. Eligibility, enrollment date, tobacco rating and final application can change the premium. Quote Scout does not enroll or broker insurance.');
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

// ---------------------------------------------------------------- marketplace

const METAL_ORDER = { Catastrophic: 0, Bronze: 1, 'Expanded Bronze': 2, Silver: 3, Gold: 4, Platinum: 5, Low: 1, High: 2 };
const STATE_NAMES = { AK: 'Alaska', AL: 'Alabama', AR: 'Arkansas', AZ: 'Arizona', CA: 'California', CO: 'Colorado', CT: 'Connecticut', DC: 'the District of Columbia', DE: 'Delaware', FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', IA: 'Iowa', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', MA: 'Massachusetts', MD: 'Maryland', ME: 'Maine', MI: 'Michigan', MN: 'Minnesota', MO: 'Missouri', MS: 'Mississippi', MT: 'Montana', NC: 'North Carolina', ND: 'North Dakota', NE: 'Nebraska', NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico', NV: 'Nevada', NY: 'New York', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VA: 'Virginia', VT: 'Vermont', WA: 'Washington', WI: 'Wisconsin', WV: 'West Virginia', WY: 'Wyoming' };

/**
 * Turns the published CMS dataset into Quote Scout results.
 *
 * Every premium here is a number the insurer filed and CMS published for the
 * plan year, which is why these carry the AUTHORITATIVE PUBLIC RATE status
 * rather than ESTIMATE: nothing is modelled or approximated. What the status
 * does not promise is a personal quote, because the full premium shown ignores
 * any premium tax credit, which depends on household details the app does not
 * collect.
 */
export function marketplaceQuotes(input, { dental = false, provider = 'cms-puf', now = Date.now(), ttl }) {
  const meta = getMeta();
  const year = input.year;
  // The dataset is a single plan year. Offering it as though it answered for a
  // different year would be quietly wrong.
  if (year !== meta.planYear) throw new ScoutError('UNSUPPORTED');

  const counties = resolveZip(input.zip);
  if (!counties) {
    const state = stateOfZip(input.zip);
    if (!state) throw new ScoutError('INVALID_INPUT');
    throw new ScoutError('UNSUPPORTED');
  }
  const county = input.county ? counties.find(c => c.fips === input.county) : counties.length === 1 ? counties[0] : null;
  if (input.county && !county) throw new ScoutError('INVALID_INPUT');
  if (!county) {
    return { quotes: [], questions: [{ field: 'county', label: 'Your ZIP code covers more than one county, and premiums are set by county. Which one are you in?', options: counties.map(c => ({ value: c.fips, label: `${c.name}, ${c.state}` })) }] };
  }

  const found = plansFor({ state: county.state, fips: county.fips, zip: input.zip, age: input.age, tobacco: input.tobacco, dental });
  if (!found) throw new ScoutError('UNSUPPORTED');
  // Catastrophic plans are the cheapest thing in the file and are restricted to
  // people under 30 (or holding a hardship exemption, which we do not ask
  // about). Leaving them in would head the results with the one plan a
  // 40-year-old cannot buy.
  const catastrophic = found.plans.filter(p => p.metal === 'Catastrophic').length;
  const ageRestricted = !dental && input.age >= 30 && catastrophic > 0;
  if (ageRestricted) found.plans = found.plans.filter(p => p.metal !== 'Catastrophic');
  const benchmark = dental ? null : benchmarkSilver(found.plans);
  const vertical = dental ? 'dental-insurance' : 'health-insurance';
  const stateName = STATE_NAMES[county.state] || county.state;

  const quotes = found.plans.map(plan => {
    const annual = plan.premium * 12;
    const product = { age: input.age, tobacco: input.tobacco, year, people: 1, subsidies: false, county: county.fips, ratingArea: found.ratingArea, metal: plan.metal, planType: plan.planType, market: dental ? 'Individual dental' : 'Individual medical' };
    return {
      id: `${provider}:${plan.id}`,
      provider,
      providerName: plan.issuer,
      name: plan.name,
      vertical,
      amount: plan.premium,
      currency: 'USD',
      interval: 'month',
      annual,
      deductible: plan.deductible,
      outOfPocket: plan.outOfPocket,
      status: 'AUTHORITATIVE PUBLIC RATE',
      retrievedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + ttl).toISOString(),
      // Metal level and plan type both change what is being bought, so they
      // decide the comparison group. Networks still differ inside a group,
      // which the label says out loud.
      comparisonKey: `${dental ? 'dental' : 'health'}:${plan.metal}:${plan.planType}`,
      comparisonLabel: `${plan.metal} · ${plan.planType} (networks and benefits differ)`,
      details: {
        'Metal level': plan.metal,
        'Plan type': plan.planType,
        'Coverage year': String(year),
        'Monthly premium': 'Full price before any premium tax credit',
        'Deductible basis': plan.deductible === null ? 'Not published in a single comparable figure' : plan.deductibleCombined ? 'Individual, in-network, medical and drug combined' : 'Individual, in-network medical (drugs may be separate)',
        'Tobacco rating': plan.tobaccoRated ? (input.tobacco ? 'Tobacco rate applied' : 'Non-tobacco rate applied') : 'This insurer files one rate regardless of tobacco use',
        'HSA eligible': plan.hsaEligible ? 'Yes' : 'No',
        Network: plan.nationalNetwork ? 'Insurer reports a national network; confirm your doctors' : 'Confirm your doctors with the insurer; networks differ by plan',
        'Rating area': `${stateName} rating area ${found.ratingArea}`,
        County: `${county.name}, ${county.state}`,
        ...(plan.multipleTiers ? { 'Provider tiers': 'This plan has more than one in-network tier; shown figures are tier 1' } : {}),
        ...(benchmark ? { 'Benchmark premium': `${(benchmark / 100).toFixed(2)} USD is the second-lowest silver premium here, which is what tax credits are calculated against` } : {}),
      },
      provenance: {
        source: `CMS Health Insurance Exchange Public Use Files, plan year ${meta.planYear}`,
        sourceId: plan.id,
        kind: 'published-rate',
        planYear: meta.planYear,
        dataPublishedAt: meta.pufImportDate,
        datasetBuiltAt: meta.generatedAt,
        transformations: ['Rate PUF premium for this plan, rating area, age and tobacco status', 'Monthly premium x 12 for annual premium'],
        product,
        checkoutExact: false,
        warning: `Full premium before any premium tax credit. Quote Scout does not enroll, broker or sell insurance. Eligibility, household size, income, enrollment date and the insurer's final application can all change what you pay.`,
      },
      continueUrl: 'https://www.healthcare.gov/see-plans/',
      continueLabel: 'Review and enroll on HealthCare.gov',
      affiliate: false,
    };
  }).sort((a, b) => (METAL_ORDER[a.details['Metal level']] ?? 9) - (METAL_ORDER[b.details['Metal level']] ?? 9) || a.amount - b.amount);

  const warnings = [];
  if (!quotes.length) warnings.push(`No ${dental ? 'dental' : 'medical'} plans are published for ${county.name}, ${county.state} in plan year ${year}.`);
  if (ageRestricted) warnings.push(`${catastrophic} catastrophic plan${catastrophic === 1 ? '' : 's'} were left out: those are only sold to people under 30 or with a hardship exemption.`);
  return { quotes, warning: warnings.join(' ') || null };
}

export function createAdapters(config = {}, fetcher = fetch, now = Date.now) {
  const marketplaceTTL = 6 * 3600000;
  const cmsURL = path => `https://marketplace.api.healthcare.gov/api/v1/${path}${path.includes('?') ? '&' : '?'}apikey=${encodeURIComponent(config.cmsKey)}`;
  return [
    // Needs no credential: the dataset ships with the function.
    { id: 'cms-puf', name: 'CMS Marketplace plan data', vertical: 'health-insurance', enabled: true, external: false, capability: 'Public data', ttl: marketplaceTTL,
      async quote(input) { return marketplaceQuotes(input, { provider: 'cms-puf', now: now(), ttl: marketplaceTTL }); } },
    { id: 'cms-puf-dental', name: 'CMS Marketplace dental plan data', vertical: 'dental-insurance', enabled: true, external: false, capability: 'Public data', ttl: marketplaceTTL,
      async quote(input) { return marketplaceQuotes(input, { dental: true, provider: 'cms-puf-dental', now: now(), ttl: marketplaceTTL }); } },
    { id: 'easypost', name: 'EasyPost', vertical: 'package-shipping', enabled: !!config.easypostKey, external: true, capability: 'Beta', ttl: 300000,
      async quote(input, ctx) {
        const data = await upstream('https://api.easypost.com/beta/rates', { ...ctx, fetcher, method: 'POST', headers: { Authorization: `Basic ${Buffer.from(`${config.easypostKey}:`).toString('base64')}`, 'Content-Type': 'application/json' }, body: { shipment: { from_address: { zip: input.originZip, country: 'US' }, to_address: { zip: input.destinationZip, country: 'US' }, parcel: { weight: input.weight, length: input.length, width: input.width, height: input.height }, carrier_accounts: config.carrierAccounts } } });
        return normalizeEasyPost(data, input, now());
      } },
    { id: 'cms', name: 'CMS Marketplace API', vertical: 'health-insurance', enabled: !!config.cmsKey, external: true, capability: 'Beta', ttl: 900000,
      async quote(input, ctx) {
        const data = await ctx.enrich(`county:${input.year}:${input.zip}`, 86400000, async () => {
          const result = await upstream(cmsURL(`counties/by/zip/${input.zip}?year=${input.year}`), { ...ctx, fetcher });
          if (!Array.isArray(result.counties) || result.counties.length > 30 || result.counties.some(c => !/^\d{5}$/.test(c.fips) || !/^[A-Z]{2}$/.test(c.state) || !text(c.name))) throw new ScoutError('MALFORMED');
          return { counties: result.counties.map(c => ({ fips: c.fips, state: c.state, name: c.name })) };
        });
        if (!data.counties.length) throw new ScoutError('UNSUPPORTED');
        const county = input.county ? data.counties.find(c => c.fips === input.county) : data.counties.length === 1 ? data.counties[0] : null;
        if (input.county && !county) throw new ScoutError('INVALID_INPUT');
        if (!county) return { quotes: [], questions: [{ field: 'county', label: 'Your ZIP includes more than one county. CMS needs your county to find the right plans.', options: data.counties.map(c => ({ value: c.fips, label: `${c.name}, ${c.state}` })) }] };
        const place = { countyfips: county.fips, state: county.state, zipcode: input.zip };
        const plans = await upstream(cmsURL('plans/search'), { ...ctx, fetcher, method: 'POST', headers: { 'Content-Type': 'application/json' }, body: { place, year: input.year, market: 'Individual', sort: 'premium', order: 'asc', household: { people: [{ age: input.age, uses_tobacco: input.tobacco, aptc_eligible: false }] }, aptc_override: 0 } });
        return normalizeCMS(plans, input, place, now());
      } },
    { id: 'vpic', name: 'NHTSA vPIC', vertical: 'vehicle-data', enabled: true, external: true, capability: 'Public data', ttl: 900000,
      async quote(input, ctx) {
        const vehicle = await ctx.enrich(`vin:${input.vin}`, 30 * 86400000, async () => {
          const data = await upstream(`https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVinValues/${input.vin}?format=json`, { ...ctx, fetcher });
          const v = data.Results?.[0];
          if (!v || !text(v.Make) || !text(v.Model) || !/^\d{4}$/.test(v.ModelYear)) throw new ScoutError('UNSUPPORTED');
          if (typeof v.ErrorCode !== 'string' || v.ErrorCode.split(',').some(c => c.trim() !== '0')) throw new ScoutError('UNSUPPORTED');
          // Cache only validated specifications, never the VIN-bearing raw response.
          return { make: v.Make, model: v.Model, year: v.ModelYear, trim: text(v.Trim), body: text(v.BodyClass), engine: text(v.EngineModel), fuel: text(v.FuelTypePrimary), retrievedAt: new Date(now()).toISOString(), source: 'NHTSA vPIC manufacturer-reported data', warning: 'Decoded specifications are not a title, history, recall or insurance-eligibility check.' };
        });
        return { quotes: [], vehicle };
      } },
  ];
}
