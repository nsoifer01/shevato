import { upstream } from './http.mjs';
import { ScoutError } from './validation.mjs';

// Upstream strings are untrusted: bounded length, no control characters.
const text = (v, max = 160) => typeof v === 'string' && v.length > 0 && v.length <= max && !/[\x00-\x1f]/.test(v) ? v : null;
import { getMeta, resolveZip, stateOfZip, plansFor, benchmarkSilver, medicarePlansFor } from './marketplace.mjs';
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
  if (!counties) throw new ScoutError(stateOfZip(input.zip) ? 'UNSUPPORTED' : 'INVALID_INPUT');
  // The ZIP index is nationwide because Medicare is. Refuse an uncovered state
  // here, before asking which county someone is in, because that question is
  // pointless when the answer changes nothing.
  if (!counties.some(c => meta.states.includes(c.state))) throw new ScoutError('UNSUPPORTED');
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


// -------------------------------------------------------------------- medicare

/**
 * Medicare Advantage and standalone Part D plans for one county.
 *
 * These are the premiums CMS published in the plan year's landscape file, so
 * they carry the same AUTHORITATIVE PUBLIC RATE status as the marketplace
 * rates. Medicare premiums do not vary with age, sex or tobacco, so a ZIP is
 * the only thing anyone has to type; where a ZIP straddles counties we ask,
 * because Advantage plans are sold county by county.
 *
 * What the premium does not include is Part B, which nearly every enrollee pays
 * to the government separately. Saying so on every result matters more here
 * than anywhere else in the app, because a $0 Advantage premium is otherwise
 * read as free healthcare.
 */
export function medicareQuotes(input, { drug = false, provider, now = Date.now(), ttl }) {
  const meta = getMeta();
  const counties = resolveZip(input.zip);
  if (!counties) throw new ScoutError(stateOfZip(input.zip) ? 'UNSUPPORTED' : 'INVALID_INPUT');
  const county = input.county ? counties.find(c => c.fips === input.county) : counties.length === 1 ? counties[0] : null;
  if (input.county && !county) throw new ScoutError('INVALID_INPUT');
  if (!county) {
    return { quotes: [], questions: [{ field: 'county', label: 'Your ZIP code covers more than one county, and Medicare Advantage plans are sold county by county. Which one are you in?', options: counties.map(c => ({ value: c.fips, label: `${c.name}, ${c.state}` })) }] };
  }

  const found = medicarePlansFor({ state: county.state, fips: county.fips });
  if (!found) throw new ScoutError('UNSUPPORTED');
  const plans = drug ? found.drug : found.advantage;
  const vertical = drug ? 'medicare-drug' : 'medicare-advantage';

  const quotes = plans.map(plan => {
    const annual = plan.prem * 12;
    return {
      id: `${provider}:${plan.id}`,
      provider,
      providerName: plan.i,
      name: plan.n,
      vertical,
      amount: plan.prem,
      currency: 'USD',
      interval: 'month',
      annual,
      deductible: plan.ded ?? null,
      outOfPocket: drug ? null : plan.moop ?? null,
      rating: plan.star ?? null,
      // A $0 Advantage premium is the most misleading number in this app if the
      // Part B premium is only mentioned behind a disclosure, so it goes on the
      // face of the card next to the price.
      note: 'Plus the Part B premium you pay Medicare separately.',
      status: 'AUTHORITATIVE PUBLIC RATE',
      retrievedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + ttl).toISOString(),
      // Drug coverage and plan type both change what is being bought, so they
      // decide the group. A PPO without drugs is not a cheaper HMO with them.
      comparisonKey: drug ? `part-d:${plan.type}` : `medicare:${plan.t}:${plan.drug ? 'with-drugs' : 'no-drugs'}`,
      comparisonLabel: drug ? `${plan.type} drug coverage` : `${plan.t} · ${plan.drug ? 'includes drug coverage' : 'no drug coverage'} (networks differ)`,
      details: {
        'Plan type': drug ? 'Standalone Part D drug plan' : plan.t,
        'Drug coverage': drug ? plan.type : plan.drug ? 'Included' : 'Not included; a separate Part D plan would be needed',
        'Star rating': plan.star == null ? 'Not rated by CMS for this plan year' : `${plan.star} out of 5 (CMS overall rating)`,
        'Part B premium': 'Not included. You keep paying Part B to Medicare separately, on top of this premium',
        ...(drug ? {} : { 'Max out-of-pocket': plan.moop == null ? 'Not published' : 'In-network, medical, per year' }),
        'Coverage year': String(found.year),
        County: `${county.name}, ${county.state}`,
        ...(drug ? { 'Drug plan region': found.region || county.state } : {}),
        Enrollment: 'Check the plan covers your doctors and medicines before enrolling',
      },
      provenance: {
        source: `CMS Medicare Advantage and Part D landscape file, contract year ${found.year}`,
        sourceId: plan.id,
        kind: 'published-rate',
        planYear: found.year,
        dataPublishedAt: meta.medicare?.publishedAt || meta.pufImportDate,
        transformations: ['Landscape file premium for this plan and county', 'Monthly premium x 12 for annual premium'],
        product: { county: county.fips, state: county.state, year: found.year, drugPlan: drug, partB: false },
        checkoutExact: false,
        warning: 'Published plan premium, and not the whole of what you pay: the Part B premium is separate, and late-enrolment penalties, extra help and state programs can change your cost. Quote Scout does not enroll or broker Medicare plans, and special-needs plans are excluded because they are restricted to people who qualify.',
      },
      continueUrl: 'https://www.medicare.gov/plan-compare/',
      continueLabel: 'Compare and enroll on Medicare.gov',
      affiliate: false,
    };
  }).sort((a, b) => a.amount - b.amount);

  return { quotes, warning: quotes.length ? null : `No ${drug ? 'standalone drug' : 'Medicare Advantage'} plans are published for ${county.name}, ${county.state} in ${found.year}.` };
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
    { id: 'medicare-advantage', name: 'CMS Medicare plan data', vertical: 'medicare-advantage', enabled: true, external: false, capability: 'Public data', ttl: marketplaceTTL,
      async quote(input) { return medicareQuotes(input, { provider: 'medicare-advantage', now: now(), ttl: marketplaceTTL }); } },
    { id: 'medicare-drug', name: 'CMS Medicare drug plan data', vertical: 'medicare-drug', enabled: true, external: false, capability: 'Public data', ttl: marketplaceTTL,
      async quote(input) { return medicareQuotes(input, { drug: true, provider: 'medicare-drug', now: now(), ttl: marketplaceTTL }); } },
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
