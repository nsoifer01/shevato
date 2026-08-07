/**
 * Reports which URL actually 404'd.
 *
 * 404.html pins page_path to "/404" so one broken link cannot create one row
 * in Pages and Screens. That keeps the report clean but would lose the thing
 * we actually want from a 404: which URLs people and crawlers are asking for.
 * This sends that path once, as an event parameter.
 *
 * Deferred, and loaded after analytics.js, so window.shevatoAnalytics exists.
 */
(function () {
  'use strict';
  var analytics = window.shevatoAnalytics;
  if (!analytics) return;

  // Path only — never the query string or hash. A mistyped or malicious URL
  // can carry anything in its query, and none of it belongs in analytics.
  var requestedPath = String(window.location.pathname || '').slice(0, 100);

  analytics.track('page_not_found', {
    not_found_path: requestedPath,
    // Where the broken link was followed from, when the browser tells us.
    // Same-origin referrers point at our own broken links, which are the ones
    // we can actually fix.
    referrer_domain: (function () {
      try {
        return document.referrer ? new URL(document.referrer).hostname : '(none)';
      } catch (e) { return '(none)'; }
    })()
  });
})();
