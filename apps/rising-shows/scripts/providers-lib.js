// Streaming-provider vocabulary, shared by every surface that names a service:
// scripts/build-data.js (which normalizes what TMDB returns before it ever
// reaches data.json), scripts/render-show-page.js (the static show pages) and
// the browser app. One definition so a page can never spell a service
// differently from the app for the same show.
//
// Keep this file free of Node-specific APIs (no fs/path/process) and free of
// DOM access - see the UMD-style export at the bottom, same as finder-lib.js.
'use strict';

// Wrapped so nothing leaks into the page's global scope. These are classic
// scripts, not modules: finder-lib.js and integrations-lib.js each declare a
// top-level `const API`, and a second top-level `const API` here is a duplicate
// declaration that kills THIS WHOLE FILE at parse time (caught by the browser
// suite: "Identifier 'API' has already been declared", after which
// window.RisingShowsProviders never existed and every provider chip silently
// vanished). Same class of collision the comment above buildShowAggFromDataset
// in js/app.js describes.
(function () {

// TMDB returns each plan as a separate provider ("Netflix" / "Netflix
// Standard with Ads", "Peacock Premium" / "Peacock Premium Plus", channel
// variants like "HBO Max Amazon Channel"). Users care about the brand, so
// collapse to the parent. Anything we don't recognize passes through.
function normalizeProvider(name) {
  if (typeof name !== 'string') return name;
  if (/^Netflix/i.test(name)) return 'Netflix';
  if (/^Amazon Prime Video/i.test(name)) return 'Amazon Prime Video';
  if (/^HBO Max/i.test(name)) return 'HBO Max';
  if (/^Max\b/i.test(name)) return 'HBO Max';
  if (/^Peacock/i.test(name)) return 'Peacock';
  if (/^Hulu/i.test(name)) return 'Hulu';
  if (/^Disney( Plus|\+)/i.test(name)) return 'Disney+';
  if (/^Apple TV/i.test(name)) return 'Apple TV+';
  if (/^Paramount( Plus|\+)/i.test(name)) return 'Paramount+';
  if (/^Crunchyroll/i.test(name)) return 'Crunchyroll';
  if (/^Starz/i.test(name)) return 'Starz';
  if (/^Showtime/i.test(name)) return 'Showtime';
  if (/^AMC\+/i.test(name) || /^AMC Plus/i.test(name)) return 'AMC+';
  return name;
}

// The services worth naming on a card, a page or a filter chip. TMDB lists
// ~200 providers including aggregator listings ("BritBox Amazon Channel"),
// bundlers (Spectrum / Philo / fuboTV), niche specialty channels (Acorn TV)
// and free ad-supported services (Tubi, Pluto, The Roku Channel); keeping the
// list to the major subscription services makes the metadata read at a glance.
//
// 'Max' is unreachable for anything that has been through normalizeProvider
// (it maps to 'HBO Max'). It stays in the set on purpose so a raw, unnormalized
// name still matches.
const MAINSTREAM_PROVIDERS = new Set([
  'Netflix',
  'Hulu',
  'Amazon Prime Video',
  'HBO Max',
  'Max',
  'Disney+',
  'Peacock',
  'Paramount+',
  'Apple TV+',
  'Crunchyroll',
]);

// One list in, the display list out: trimmed, brand-normalized, filtered to the
// mainstream set and de-duplicated in first-seen order. This is what a surface
// should call - the static show pages, the app's cards, rows and modal - so
// that "which services does this show name" has exactly one answer everywhere.
function normalizeProviders(providers) {
  if (!Array.isArray(providers)) return [];
  const seen = new Set();
  const out = [];
  for (const raw of providers) {
    if (typeof raw !== 'string') continue;
    const name = normalizeProvider(raw.trim());
    if (!MAINSTREAM_PROVIDERS.has(name) || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

// True when a name belongs to the mainstream vocabulary, normalizing first so a
// raw TMDB plan name ("Netflix Standard with Ads") answers the same as the
// brand it collapses to.
function isMainstreamProvider(name) {
  if (typeof name !== 'string') return false;
  return MAINSTREAM_PROVIDERS.has(normalizeProvider(name.trim()));
}

const api = {
  normalizeProvider, normalizeProviders, isMainstreamProvider, MAINSTREAM_PROVIDERS,
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = api;
} else if (typeof window !== 'undefined') {
  window.RisingShowsProviders = api;
}
}());
