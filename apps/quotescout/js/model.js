// Shared vocabulary and deterministic presentation logic. No provider secrets or fixtures.
export const VERTICALS = [
  { id: 'auto-insurance', name: 'Auto Insurance', modes: ['cheapest', 'best-value'], dimensions: ['liability', 'collision', 'comprehensive', 'deductibles', 'uninsuredMotorist', 'rental'], reason: 'Live comparison requires an approved licensed insurance partner.' },
  { id: 'vehicle-shipping', name: 'Vehicle Shipping', modes: ['cheapest', 'best-value', 'fastest'], dimensions: ['transport', 'handoff', 'insurance', 'pickupWindow'], reason: 'Live comparison requires a transport provider agreement.' },
  { id: 'vehicle-warranty', name: 'Vehicle Service Contracts', modes: ['cheapest', 'best-value', 'lowest-deductible'], dimensions: ['termMonths', 'mileageLimit', 'deductible', 'components', 'exclusions'], reason: 'Purchasable plans require an administrator integration.' },
  { id: 'health-insurance', name: 'Health Insurance', modes: ['cheapest', 'best-value', 'lowest-deductible'], dimensions: ['metal', 'planType', 'network', 'deductible', 'outOfPocket'], reason: 'CMS publishes plan data only for states whose marketplace runs on HealthCare.gov.' },
  { id: 'dental-insurance', name: 'Dental Insurance', modes: ['cheapest', 'lowest-deductible'], dimensions: ['planType', 'network', 'deductible'], reason: 'CMS publishes plan data only for states whose marketplace runs on HealthCare.gov.' },
  { id: 'home-insurance', name: 'Home Insurance', modes: ['cheapest', 'best-value'], dimensions: ['dwelling', 'liability', 'deductible', 'perils', 'replacementCost'], reason: 'Live comparison requires an approved licensed insurance partner.' },
  { id: 'internet', name: 'Internet', modes: ['cheapest', 'best-value'], dimensions: ['download', 'upload', 'dataCap', 'term', 'fees', 'availability'], reason: 'Address-level pricing and availability are not connected.' },
  { id: 'package-shipping', name: 'Package Shipping', modes: ['cheapest', 'best-value', 'fastest'], dimensions: ['deliveryGuarantee', 'insurance', 'tracking'], reason: 'Carrier rate estimates become available after API access is configured.' },
  { id: 'energy', name: 'Electricity / Energy Plans', modes: ['cheapest', 'best-value'], dimensions: ['utility', 'usage', 'rateType', 'term', 'fees', 'renewable'], reason: 'Utility-level eligibility and retail plan data are not connected. State alone cannot establish eligibility.' },
];

// How a displayed price was obtained. The distinction is the product: a rate a
// government body published is not the same thing as a rate a carrier quoted
// for one person, and neither is an estimate.
export const STATUSES = ['VERIFIED QUOTE', 'AUTHORITATIVE PUBLIC RATE', 'ESTIMATE', 'UNAVAILABLE', 'ERROR', 'EXPIRED'];
export const PRICED = ['VERIFIED QUOTE', 'AUTHORITATIVE PUBLIC RATE', 'ESTIMATE'];
export const STATUS_LABELS = {
  'VERIFIED QUOTE': 'Verified quote',
  'AUTHORITATIVE PUBLIC RATE': 'Published rate',
  ESTIMATE: 'Estimate',
  EXPIRED: 'Expired',
};
export const STATUS_MEANING = {
  'VERIFIED QUOTE': 'A provider returned this price for the details you entered.',
  'AUTHORITATIVE PUBLIC RATE': 'The price the insurer filed with the government for this plan year, published by CMS. It is the full premium before any tax credit.',
  ESTIMATE: 'An indicative price from a source that publishes estimates. The final price can differ.',
  EXPIRED: 'This price is older than its source allows us to show. Refresh to check again.',
};
export const MODE_LABELS = { cheapest: 'Cheapest', 'best-value': 'Best value', fastest: 'Fastest', 'lowest-deductible': 'Lowest deductible' };
export function isFresh(q, now = Date.now()) { return PRICED.includes(q.status) && Date.parse(q.expiresAt) > now; }

export function rankQuotes(quotes, mode = 'cheapest', now = Date.now()) {
  const score = q => {
    if (mode === 'fastest') return q.deliveryDays ?? Infinity;
    if (mode === 'lowest-deductible') return q.deductible ?? Infinity;
    if (mode === 'best-value') {
      // Explicit tradeoff, not an opaque endorsement. Comparisons stay grouped.
      if (q.vertical === 'package-shipping') return q.amount + (q.deliveryDays ?? Infinity) * 100;
      if (q.vertical === 'health-insurance') return q.annual + (q.outOfPocket ?? Infinity);
    }
    return q.amount;
  };
  const groups = new Map();
  for (const q of quotes.filter(q => isFresh(q, now))) {
    const key = `${q.currency}:${q.comparisonKey}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(q);
  }
  return [...groups].map(([key, items]) => ({
    key, label: items[0].comparisonLabel,
    quotes: items.sort((a, b) => score(a) - score(b) || a.amount - b.amount || (a.status === 'VERIFIED QUOTE' ? 0 : 1) - (b.status === 'VERIFIED QUOTE' ? 0 : 1) || a.id.localeCompare(b.id)),
    reason: reasonFor(mode, items[0].vertical),
  }))
    // The group holding the best option under the chosen ranking leads, so the
    // first thing on screen is the answer rather than whichever product group
    // happened to sort first alphabetically.
    .sort((a, b) => score(a.quotes[0]) - score(b.quotes[0]) || a.key.localeCompare(b.key));
}

function reasonFor(mode, vertical) {
  if (mode === 'best-value') {
    return vertical === 'package-shipping'
      ? 'Price plus $1 for each estimated transit day. Unknown transit times sort last. Delivery is not guaranteed unless stated.'
      : 'Annual premium plus in-network maximum out-of-pocket: a worst-case covered-care comparison, not expected annual spending. Networks can differ.';
  }
  if (mode === 'fastest') return 'Shortest reported transit first, then price. Unknown transit times sort last.';
  if (mode === 'lowest-deductible') return 'Lowest reported individual in-network deductible, then premium. Unknown deductibles sort last.';
  return 'Lowest price within this product group. Different groups are not ranked against each other.';
}

export function money(cents, currency = 'USD') { return Number.isSafeInteger(cents) ? new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(cents / 100) : 'Not reported'; }

// A published dataset has a vintage, not a retrieval time. Saying "retrieved 4
// seconds ago" about a rate filed last October would be a lie about freshness,
// which is exactly the kind of thing this app exists not to do.
export function freshness(q, now = Date.now()) {
  const p = q.provenance || {};
  if (p.kind === 'published-rate') {
    const published = p.dataPublishedAt ? new Date(`${p.dataPublishedAt}T00:00:00Z`) : null;
    const when = published && !Number.isNaN(published.getTime())
      ? published.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' })
      : 'an unstated date';
    return `Plan year ${p.planYear} rate, published by CMS on ${when}.`;
  }
  const seconds = Math.max(0, Math.round((now - Date.parse(q.retrievedAt)) / 1000));
  const ago = seconds < 60 ? `${seconds} second${seconds === 1 ? '' : 's'} ago` : `${Math.round(seconds / 60)} minute(s) ago`;
  return `Retrieved ${ago}.`;
}
