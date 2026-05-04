/**
 * Apex (/) → /home.html client-side redirect.
 * The <meta http-equiv="refresh"> on /index.html is the no-JS fallback;
 * this script just runs sooner so the URL change feels instant.
 *
 * Lives outside index.html so the page works under a strict CSP without
 * needing 'unsafe-inline' or a per-deploy script-hash.
 */
window.location.replace('/home.html');
