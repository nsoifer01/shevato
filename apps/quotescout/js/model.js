// Shared vocabulary and deterministic presentation logic. No provider secrets or fixtures.
export const VERTICALS = [
  { id: 'auto-insurance', name: 'Auto Insurance', modes: ['cheapest', 'best-value'], dimensions: ['liability', 'collision', 'comprehensive', 'deductibles', 'uninsuredMotorist', 'rental'], reason: 'Live comparison requires an approved licensed insurance partner.' },
  { id: 'vehicle-shipping', name: 'Vehicle Shipping', modes: ['cheapest', 'best-value', 'fastest'], dimensions: ['transport', 'handoff', 'insurance', 'pickupWindow'], reason: 'Live comparison requires a transport provider agreement.' },
  { id: 'vehicle-warranty', name: 'Vehicle Service Contracts', modes: ['cheapest', 'best-value', 'lowest-deductible'], dimensions: ['termMonths', 'mileageLimit', 'deductible', 'components', 'exclusions'], reason: 'Purchasable plans require an administrator integration.' },
  { id: 'health-insurance', name: 'Health Insurance', modes: ['cheapest', 'best-value', 'lowest-deductible'], dimensions: ['metal', 'planType', 'network', 'deductible', 'outOfPocket'], reason: 'CMS plan estimates become available after API access is configured.' },
  { id: 'home-insurance', name: 'Home Insurance', modes: ['cheapest', 'best-value'], dimensions: ['dwelling', 'liability', 'deductible', 'perils', 'replacementCost'], reason: 'Live comparison requires an approved licensed insurance partner.' },
  { id: 'internet', name: 'Internet', modes: ['cheapest', 'best-value'], dimensions: ['download', 'upload', 'dataCap', 'term', 'fees', 'availability'], reason: 'Address-level pricing and availability are not connected.' },
  { id: 'package-shipping', name: 'Package Shipping', modes: ['cheapest', 'best-value', 'fastest'], dimensions: ['deliveryGuarantee', 'insurance', 'tracking'], reason: 'Carrier rate estimates become available after API access is configured.' },
  { id: 'energy', name: 'Electricity / Energy Plans', modes: ['cheapest', 'best-value'], dimensions: ['utility', 'usage', 'rateType', 'term', 'fees', 'renewable'], reason: 'Utility-level eligibility and retail plan data are not connected. State alone cannot establish eligibility.' },
];
export const STATUSES = ['VERIFIED QUOTE', 'ESTIMATE', 'UNAVAILABLE', 'ERROR', 'EXPIRED'];
export const MODE_LABELS = { cheapest: 'Cheapest', 'best-value': 'Best value', fastest: 'Fastest', 'lowest-deductible': 'Lowest deductible' };
export function isFresh(q, now = Date.now()) { return ['VERIFIED QUOTE', 'ESTIMATE'].includes(q.status) && Date.parse(q.expiresAt) > now; }
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
  return [...groups].sort(([a], [b]) => a.localeCompare(b)).map(([key, items]) => ({
    key, label: items[0].comparisonLabel,
    quotes: items.sort((a, b) => score(a) - score(b) || a.amount - b.amount || (a.status === 'VERIFIED QUOTE' ? 0 : 1) - (b.status === 'VERIFIED QUOTE' ? 0 : 1) || a.id.localeCompare(b.id)),
    reason: mode === 'best-value' ? (items[0].vertical === 'package-shipping' ? 'Price plus $1 for each estimated transit day. Unknown transit times sort last. Delivery is not guaranteed unless stated.' : 'Annual premium plus in-network maximum out-of-pocket: a worst-case covered-care comparison, not expected annual spending. Networks can differ.') : mode === 'fastest' ? 'Shortest reported transit first, then price. Unknown transit times sort last.' : mode === 'lowest-deductible' ? 'Lowest reported individual in-network deductible, then premium. Unknown deductibles sort last.' : 'Lowest price within this product group. Different groups are not ranked against each other.',
  }));
}
export function money(cents, currency = 'USD') { return Number.isSafeInteger(cents) ? new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(cents / 100) : 'Not reported'; }
