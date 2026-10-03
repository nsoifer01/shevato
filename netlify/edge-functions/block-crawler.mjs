// Turns away one automated scraper before it reaches a page.
//
// Since the BigQuery export began (2026-08-08) a client identifying as
// Chrome 99.0.4844.51 on Windows 10, from China, has fetched one generated
// page per visit, mostly Rising Shows show pages, and run their JavaScript, so
// GA4 counted every fetch as a brand-new user. All 1,884 of its IDs to
// 2026-10-01 had exactly one page view on one day; none ever behaved like a
// person. On 2026-09-24 it stepped up about tenfold and became 1,191 of the
// 2,103 "users" in GA's 5 September - 2 October report.
//
// The match is deliberately narrow (the exact 2022 build, Windows 10 and a
// Chinese address, all three) so no real visitor on a current browser can
// trip it. Nothing is logged or stored: the request is answered 403 and
// forgotten. Root FINDINGS.md, "The Chrome 99 crawler", has the evidence.

const UA_BUILD = 'Chrome/99.0.4844.51';
const UA_OS = 'Windows NT 10.0';
const COUNTRY = 'CN';

/** True only for the scraper's exact fingerprint. */
export function isBlockedCrawler(userAgent, countryCode) {
  const ua = String(userAgent || '');
  return countryCode === COUNTRY && ua.includes(UA_BUILD) && ua.includes(UA_OS);
}

export default async (request, context) => {
  if (!isBlockedCrawler(request.headers.get('user-agent'), context?.geo?.country?.code)) return;
  return new Response('Forbidden\n', {
    status: 403,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
      'x-robots-tag': 'noindex',
    },
  });
};

// Pages only: static files and functions never run this, which keeps the
// invocation count to roughly the page-view count.
export const config = {
  path: '/*',
  excludedPath: [
    '/.netlify/*',
    '/assets/*',
    '/images/*',
    '/*.js',
    '/*.mjs',
    '/*.css',
    '/*.json',
    '/*.webmanifest',
    '/*.xml',
    '/*.txt',
    '/*.ico',
    '/*.png',
    '/*.jpg',
    '/*.jpeg',
    '/*.webp',
    '/*.svg',
    '/*.gif',
    '/*.woff',
    '/*.woff2',
  ],
};
