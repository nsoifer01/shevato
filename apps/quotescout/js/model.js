// Shared vocabulary and deterministic presentation logic. No provider secrets or fixtures.
export const VERTICALS = [
  { id: 'health-insurance', name: 'Health Insurance', modes: ['cheapest', 'best-value', 'lowest-deductible'], dimensions: ['metal', 'planType', 'network', 'deductible', 'outOfPocket'] },
  { id: 'dental-insurance', name: 'Dental Insurance', modes: ['cheapest', 'lowest-deductible'], dimensions: ['planType', 'network', 'deductible'] },
  { id: 'medicare-advantage', name: 'Medicare Advantage', modes: ['cheapest', 'best-value', 'lowest-deductible', 'best-rated'], dimensions: ['planType', 'drugCoverage', 'deductible', 'outOfPocket', 'starRating'] },
  { id: 'medicare-drug', name: 'Medicare Part D (drug plans)', modes: ['cheapest', 'lowest-deductible', 'best-rated'], dimensions: ['benefitType', 'deductible', 'starRating'] },
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
// The only destinations a quote may hand a visitor to. Kept here so the server
// verifier and the renderer cannot drift apart, and so adding one is a
// deliberate edit rather than an adapter's free choice.
export const CONTINUE_URLS = ['https://www.healthcare.gov/see-plans/', 'https://www.medicare.gov/plan-compare/'];
export const MODE_LABELS = { cheapest: 'Cheapest', 'best-value': 'Best value', 'lowest-deductible': 'Lowest deductible', 'best-rated': 'Best rated' };
export function isFresh(q, now = Date.now()) { return PRICED.includes(q.status) && Date.parse(q.expiresAt) > now; }

export function rankQuotes(quotes, mode = 'cheapest', now = Date.now()) {
  const score = q => {
    if (mode === 'lowest-deductible') return q.deductible ?? Infinity;
    // Higher stars are better, so the sign flips; unrated plans sort last
    // rather than being treated as zero-star.
    if (mode === 'best-rated') return q.rating == null ? Infinity : -q.rating;
    // Explicit tradeoff, not an opaque endorsement. Comparisons stay grouped.
    if (mode === 'best-value') return q.annual + (q.outOfPocket ?? Infinity);
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
    reason: reasonFor(mode),
  }))
    // The group holding the best option under the chosen ranking leads, so the
    // first thing on screen is the answer rather than whichever product group
    // happened to sort first alphabetically.
    .sort((a, b) => score(a.quotes[0]) - score(b.quotes[0]) || a.key.localeCompare(b.key));
}

function reasonFor(mode) {
  if (mode === 'best-value') return 'Annual premium plus in-network maximum out-of-pocket: a worst-case covered-care comparison, not expected annual spending. Networks can differ.';
  if (mode === 'lowest-deductible') return 'Lowest reported deductible, then premium. Unknown deductibles sort last.';
  if (mode === 'best-rated') return 'Highest CMS star rating first, then price. CMS rates plan quality, not whether the plan suits you. Unrated plans sort last.';
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
