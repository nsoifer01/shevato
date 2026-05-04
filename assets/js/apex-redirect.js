/**
 * Apex (/) → /home.html client-side redirect.
 * The <meta http-equiv="refresh"> on /index.html is the no-JS fallback;
 * this script just runs sooner so the URL change feels instant.
 *
 * Preserves the query string and hash so campaign parameters
 * (`?utm_source=...`) and deep links (`#section`) survive the redirect —
 * dropping them would silently break analytics attribution and any
 * inbound link that targets an in-page anchor.
 *
 * Lives outside index.html so the page works under a strict CSP without
 * needing 'unsafe-inline' or a per-deploy script-hash.
 */
window.location.replace('/home.html' + window.location.search + window.location.hash);
