/**
 * Shevato analytics — the single place GA4 is configured and the single API
 * the rest of the site and the apps are allowed to use.
 *
 * Design rules, in priority order:
 *
 *   1. Analytics must NEVER break the page. Every public method swallows its
 *      own errors. If gtag.js is blocked, absent, or throws, callers keep
 *      running as if the call succeeded.
 *   2. No personal data. We never send user-entered free text (search boxes,
 *      trip names, notes, exercise names typed by hand), no email addresses,
 *      no account ids, no Firestore paths. See sendSafely() for the guard.
 *   3. One page_view per page load, ever. In-app navigation reports a
 *      custom `app_view` event instead of a synthetic page_view, so client
 *      routing can never invent new URLs in the Pages and Screens report.
 *   4. Bounded event volume. Repeated identical view/filter events are
 *      deduplicated, and errors are capped per page load.
 *
 * Loaded with `defer`, alongside `<script async src="…/gtag/js?id=…">`.
 * A page may set window.SHEVATO_ANALYTICS_CONFIG inline before this file to
 * override the reported page_path (used by 404.html).
 */
(function () {
  'use strict';

  var MEASUREMENT_ID = 'G-GEQGY35JJN';

  // Bail out if we somehow get loaded twice (a duplicate <script> tag, a
  // partial injected after boot). Re-running gtag('config') would fire a
  // second page_view for the same load and double every subsequent event.
  if (window.shevatoAnalytics) return;

  var pageConfig = window.SHEVATO_ANALYTICS_CONFIG || {};

  window.dataLayer = window.dataLayer || [];
  function gtag() { window.dataLayer.push(arguments); }
  // gtag.js installs its own identical shim; defining ours first means calls
  // made before the library finishes loading are queued rather than lost.
  if (typeof window.gtag !== 'function') window.gtag = gtag;

  /* ---------------------------------------------------------------- context */

  /**
   * Which app (if any) this page belongs to, derived from the URL rather than
   * hand-passed by each caller, so the parameter can never drift from reality.
   * `/apps/rising-shows/shows/foo/` → "rising-shows". Marketing pages → "site".
   */
  function detectApp() {
    var m = /^\/apps\/([^/]+)/.exec(window.location.pathname);
    return m ? m[1] : 'site';
  }

  var APP_NAME = detectApp();

  /**
   * Which build is running, so an error rate can be attributed to a release
   * instead of to "the site". `scripts/stamp-release.mjs` replaces the token
   * below with the deploy's short commit ref during `npm run build:site`; an
   * unstamped checkout reports "dev", which is the honest answer locally.
   */
  var RELEASE_ID = '__SHEVATO_RELEASE__';
  if (/^__/.test(RELEASE_ID)) RELEASE_ID = 'dev';
  window.SHEVATO_RELEASE = RELEASE_ID;

  /**
   * Section within an app, so Rising Shows' generated show pages can be told
   * apart from the app itself without parsing paths in the GA4 UI.
   * `/apps/rising-shows/shows/foo/` → "shows"; `/apps/rising-shows/` → "app";
   * anything outside /apps/ → "site", so a marketing page is not mislabelled
   * as an app section.
   */
  function detectAppSection() {
    if (!/^\/apps\//.test(window.location.pathname)) return 'site';
    var m = /^\/apps\/[^/]+\/([^/]+)/.exec(window.location.pathname);
    return m ? m[1] : 'app';
  }

  /* ------------------------------------------------------------ privacy net */

  // Parameter names we refuse to forward under any circumstances. This is a
  // backstop, not the primary defence — the primary defence is that callers
  // are given no helper that accepts free text in the first place.
  var BANNED_PARAM = /(^|_)(query|q|term|text|name|title|email|user|uid|account|note|address|token|key|password|search_term)$/i;

  /**
   * Structural parameter names that describe the event itself rather than
   * anything about the user, and so are exempt from BANNED_PARAM.
   *
   * Without this, the `_name$` rule above silently ate view_name, action_name
   * and filter_name - the one parameter that gives app_view, app_action and
   * filter_change their meaning - leaving every such event indistinguishable
   * in GA4. Their values are fixed literals written in our own source, never
   * user input; the rule is still doing its job on trip_name, player_name and
   * the rest.
   */
  var STRUCTURAL_PARAM = /^(view_name|action_name|filter_name)$/;

  var EMAIL_RE = /[^\s@]+@[^\s@]+\.[^\s@]+/;

  /**
   * Query parameters we deliberately keep in the URL reported to GA4.
   *
   * Everything else is dropped. This is an ALLOWLIST on purpose: `page_path`
   * alone only cleans the `dp` dimension GA4 reports, while gtag keeps
   * sending the raw `window.location.href` as `dl` (document location) and
   * the raw referrer as `dr`. So a visit to
   * `/apps/trip-planner/?anything=private` reported a clean path AND shipped
   * the full query string in the same request - the code's query-free intent
   * was true of one field and false of the wire. Setting page_location /
   * page_referrer explicitly at config time is what actually decides what
   * leaves the browser, for the automatic page_view and every later event.
   *
   * Campaign attribution is the reason this is not simply "drop everything":
   * GA4 reads utm_* / click ids out of page_location, so removing them would
   * silently break acquisition reporting.
   */
  var KEEP_QUERY_PARAM = /^(utm_(source|medium|campaign|term|content|id)|gclid|gbraid|wbraid|dclid|srsltid|msclkid|fbclid|ref)$/i;

  /** The canonical path GA4 should file this document under. */
  function canonicalPath() {
    return String(window.location.pathname).replace(/\.html$/i, '');
  }

  /**
   * `location.href` with the fragment removed and every query parameter
   * outside KEEP_QUERY_PARAM stripped. Values are clamped so an allowlisted
   * parameter cannot smuggle a payload either.
   */
  function safePageLocation() {
    try {
      var url = new URL(window.location.href);
      var kept = [];
      url.searchParams.forEach(function (value, key) {
        if (!KEEP_QUERY_PARAM.test(key)) return;
        kept.push(encodeURIComponent(key) + '=' + encodeURIComponent(String(value).slice(0, 100)));
      });
      return url.origin + canonicalPath() + (kept.length ? '?' + kept.join('&') : '');
    } catch (err) {
      return 'https://shevato.com' + canonicalPath();
    }
  }

  /**
   * The referrer with its query string and fragment removed. An origin+path
   * referrer is what referral reporting needs; the query on somebody else's
   * URL is not ours to forward, and a same-origin referrer would otherwise
   * carry our own page's private query/hash into the next page's payload.
   */
  function safePageReferrer() {
    var raw = '';
    try { raw = String(document.referrer || ''); } catch (err) { return ''; }
    if (!raw) return '';
    try {
      var url = new URL(raw);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
      return url.origin + url.pathname;
    } catch (err) { return ''; }
  }

  /**
   * Heuristic for generated identifiers (Firebase uids, session tokens), which
   * must never be sent even if a caller passes one by mistake.
   *
   * The signature it keys on is: long, unbroken by any separator, and mixing
   * upper and lower case - which is what a generated token looks like and what
   * our own values never look like. Catalogue slugs such as
   * "rick-and-morty-tt2861424" are hyphenated and lowercase, so they pass
   * through: those are exactly what content_id exists to carry, and an earlier
   * length-only rule silently swallowed them.
   */
  function looksLikeOpaqueId(value) {
    return /^[A-Za-z0-9]{20,}$/.test(value)
      && /[a-z]/.test(value)
      && /[A-Z]/.test(value);
  }

  /**
   * An error code is a short, lowercase, enumerable identifier written in our
   * own source: `quota_exceeded`, `parse-failed`, `sw_install`. Anything else
   * - a sentence, a URL, a quoted document, anything with a space or over 40
   * characters - is not a code, and is reported as `unclassified` rather than
   * forwarded. Fails closed by construction: the caller cannot widen it.
   */
  function normaliseErrorCode(value) {
    if (typeof value !== 'string') return 'unclassified';
    var trimmed = value.trim().toLowerCase();
    if (!/^[a-z][a-z0-9_.-]{0,39}$/.test(trimmed)) return 'unclassified';
    return trimmed;
  }

  /**
   * Strips parameters that could carry personal data, and clamps the rest to
   * GA4-safe primitives. Returns a fresh object; never mutates the input.
   */
  function scrub(params) {
    var safe = {};
    if (!params) return safe;
    Object.keys(params).forEach(function (key) {
      var value = params[key];
      if (value === null || value === undefined) return;
      if (!STRUCTURAL_PARAM.test(key) && BANNED_PARAM.test(key)) return;
      if (typeof value === 'number') {
        if (isFinite(value)) safe[key] = value;
        return;
      }
      if (typeof value === 'boolean') { safe[key] = value; return; }
      if (typeof value !== 'string') return;
      if (EMAIL_RE.test(value)) return;
      if (looksLikeOpaqueId(value)) return;
      // GA4 truncates parameter values at 100 chars; do it ourselves so we
      // never ship a long string we did not mean to send.
      safe[key] = value.length > 100 ? value.slice(0, 100) : value;
    });
    return safe;
  }

  /**
   * The only path to gtag(). Adds shared context, scrubs, and guarantees the
   * caller cannot be hurt by anything that happens in here.
   */
  function sendSafely(eventName, params) {
    try {
      if (typeof eventName !== 'string' || !eventName) return;
      var payload = scrub(params);
      payload.app_name = APP_NAME;
      payload.app_section = detectAppSection();
      payload.release_id = RELEASE_ID;
      window.gtag('event', eventName, payload);
    } catch (err) {
      /* analytics must never surface to the user */
    }
  }

  /* -------------------------------------------------------------- page view */

  var configParams = {
    // Report a canonical path: no query string, no hash, no `.html`.
    //
    // Campaign parameters (utm_*, gclid) are read by GA4 from the full URL
    // before page_path applies, so attribution still works — but stray query
    // junk and client-routing hashes can no longer split one page into several
    // rows in Pages and Screens.
    //
    // Dropping `.html` mirrors the canonical <link> every page already
    // declares, and belts-and-braces the 301s added in netlify.toml: even if a
    // `.html` URL is reached some way we did not foresee, GA4 still files it
    // under the one canonical row. Trailing slashes are left alone so the
    // existing directory-style URLs keep their reporting continuity.
    page_path: pageConfig.pagePath || canonicalPath(),

    // The two fields gtag would otherwise fill in from the raw URL. Setting
    // them here, BEFORE gtag('config'), is what makes the sanitisation true
    // of the request that actually leaves the browser rather than only of the
    // `dp` dimension. Both are inherited by every subsequent event on this
    // measurement id, so app_open / app_view / app_error are covered too.
    page_location: safePageLocation(),
    page_referrer: safePageReferrer()
  };
  if (pageConfig.pageTitle) configParams.page_title = pageConfig.pageTitle;

  try {
    window.gtag('js', new Date());
    window.gtag('config', MEASUREMENT_ID, configParams);
  } catch (err) { /* no-op */ }

  /* ----------------------------------------------------------- dedupe state */

  var lastView = null;
  var lastFilter = {};
  var errorsSent = 0;
  var MAX_ERRORS_PER_PAGE = 5;

  /* ----------------------------------------------------------------- public */

  var api = {
    /** Event names, centralised so callers cannot invent variants by typo. */
    events: {
      APP_OPEN: 'app_open',
      APP_VIEW: 'app_view',
      SEARCH: 'search',
      SEARCH_RESULT_SELECT: 'search_result_select',
      FILTER_CHANGE: 'filter_change',
      CONTENT_VIEW: 'content_view',
      LOAD_MORE: 'load_more',
      APP_ACTION: 'app_action',
      OUTBOUND_CLICK: 'outbound_click',
      SITE_NAV_CLICK: 'site_nav_click',
      APP_ERROR: 'app_error'
    },

    /** Escape hatch for one-off events. Still scrubbed and still safe. */
    track: function (eventName, params) { sendSafely(eventName, params); },

    /**
     * Fired once per app page load, after the app decides it is usable.
     * Distinct from page_view: page_view counts the document, app_open counts
     * a real app session start.
     */
    trackAppOpen: function (params) {
      sendSafely('app_open', params);
    },

    /**
     * In-app navigation. Deliberately NOT a page_view — see rule 3 at the top.
     * Repeated calls for the same view are dropped, so routers that re-render
     * on every state change do not spam GA4.
     */
    trackView: function (viewName, params) {
      if (typeof viewName !== 'string' || !viewName) return;
      if (viewName === lastView) return;
      lastView = viewName;
      var payload = params ? Object.assign({}, params) : {};
      payload.view_name = viewName;
      sendSafely('app_view', payload);
    },

    /**
     * A search happened. The query text is NEVER sent — only its shape and how
     * well it worked, which is what tells us whether search is useful.
     */
    trackSearch: function (opts) {
      opts = opts || {};
      sendSafely('search', {
        search_scope: opts.scope,
        results_count: typeof opts.resultsCount === 'number' ? opts.resultsCount : undefined,
        query_length: typeof opts.queryLength === 'number' ? opts.queryLength : undefined,
        has_results: typeof opts.resultsCount === 'number' ? opts.resultsCount > 0 : undefined
      });
    },

    /**
     * A search result was chosen. contentId must come from a closed catalogue
     * (a show slug, an exercise slug) — never from anything the user typed.
     * This is how we learn what people look for without storing their queries.
     */
    trackSearchResultSelect: function (opts) {
      opts = opts || {};
      sendSafely('search_result_select', {
        content_type: opts.contentType,
        content_id: opts.contentId,
        result_position: typeof opts.position === 'number' ? opts.position : undefined
      });
    },

    /**
     * A filter/sort control changed. Only pass enumerable control values
     * (a shape name, a sort key) — not free text.
     */
    trackFilter: function (filterName, filterValue) {
      if (typeof filterName !== 'string' || !filterName) return;
      var value = filterValue === undefined || filterValue === null ? '' : String(filterValue);
      if (lastFilter[filterName] === value) return;
      lastFilter[filterName] = value;
      sendSafely('filter_change', { filter_name: filterName, filter_value: value });
    },

    /**
     * Records a filter's current value as already-reported, WITHOUT sending
     * anything. Apps call this once at boot for each filter they own.
     *
     * Without it, the first time a user touches any single control, every
     * other control reports its untouched default too (the dedupe map starts
     * empty), so one interaction produced a burst of filter_change events
     * describing nothing the user did.
     */
    primeFilter: function (filterName, filterValue) {
      if (typeof filterName !== 'string' || !filterName) return;
      lastFilter[filterName] = filterValue === undefined || filterValue === null
        ? '' : String(filterValue);
    },

    /** A detail record was opened (show, exercise, rival, course). */
    trackContentView: function (opts) {
      opts = opts || {};
      sendSafely('content_view', {
        content_type: opts.contentType,
        content_id: opts.contentId
      });
    },

    /** Pagination / "load more" / infinite scroll advanced. */
    trackLoadMore: function (opts) {
      opts = opts || {};
      sendSafely('load_more', {
        page_number: typeof opts.pageNumber === 'number' ? opts.pageNumber : undefined,
        items_shown: typeof opts.itemsShown === 'number' ? opts.itemsShown : undefined
      });
    },

    /**
     * A meaningful app action completed (workout finished, match saved, trip
     * shared). actionName must be a fixed literal from the calling app.
     */
    trackAction: function (actionName, params) {
      if (typeof actionName !== 'string' || !actionName) return;
      var payload = params ? Object.assign({}, params) : {};
      payload.action_name = actionName;
      sendSafely('app_action', payload);
    },

    /** A link to another origin was followed. Domain only, never the full URL. */
    trackOutbound: function (url, params) {
      var domain = '';
      try { domain = new URL(url, window.location.href).hostname; } catch (e) { return; }
      if (!domain || domain === window.location.hostname) return;
      var payload = params ? Object.assign({}, params) : {};
      payload.link_domain = domain;
      sendSafely('outbound_click', payload);
    },

    /**
     * Something failed. Capped per page load so an error loop cannot flood GA4.
     *
     * The second argument is a STABLE CODE, not a message. It used to be free
     * text (`err.message`), protected only by the email/opaque-id heuristics -
     * and an exception message is exactly where user content ends up: a failed
     * JSON parse quotes the document, a storage error names the key, a fetch
     * failure carries the URL that was being fetched. `normaliseErrorCode`
     * refuses anything that is not already a short enumerable identifier, so
     * a caller that passes an exception message reports `unclassified`
     * instead of leaking it. Scope + code + release_id is what an owner
     * actually triages on; the text was never usable at 100 characters.
     */
    trackError: function (scope, code, params) {
      if (errorsSent >= MAX_ERRORS_PER_PAGE) return;
      errorsSent++;
      var payload = params ? Object.assign({}, params) : {};
      payload.error_scope = normaliseErrorCode(scope) === 'unclassified'
        ? 'unknown' : normaliseErrorCode(scope);
      payload.error_code = normaliseErrorCode(code);
      sendSafely('app_error', payload);
    }
  };

  /* ------------------------------------------------------- auto instruments */

  /**
   * Delegated click handling: outbound links everywhere, plus marketing-page
   * navigation. One listener for the whole document beats a listener per link,
   * and it keeps working for content rendered after load.
   */
  document.addEventListener('click', function (evt) {
    try {
      var anchor = evt.target && evt.target.closest ? evt.target.closest('a[href]') : null;
      if (!anchor) return;
      var href = anchor.getAttribute('href') || '';
      if (!href || href.charAt(0) === '#' || /^(javascript|mailto|tel):/i.test(href)) {
        // mailto/tel are conversions on the contact page, worth counting.
        if (/^(mailto|tel):/i.test(href)) {
          sendSafely('site_nav_click', {
            nav_location: navLocation(anchor),
            link_kind: href.split(':')[0].toLowerCase()
          });
        }
        return;
      }

      var url;
      try { url = new URL(href, window.location.href); } catch (e) { return; }

      if (url.hostname !== window.location.hostname) {
        api.trackOutbound(url.href, { nav_location: navLocation(anchor) });
        return;
      }

      // Internal link. On marketing pages this is the answer to "where do
      // homepage visitors go next", which page_view alone cannot tell us
      // because it never records which link produced the next page.
      sendSafely('site_nav_click', {
        nav_location: navLocation(anchor),
        link_destination: normalisePath(url.pathname),
        link_kind: 'internal'
      });
    } catch (err) { /* never interfere with the click */ }
  }, true);

  /** Where on the page a link lives, so we can rank nav vs cards vs footer. */
  function navLocation(anchor) {
    if (anchor.closest('header, #header, nav, #nav, .site-header')) return 'header';
    if (anchor.closest('footer, #footer, .site-footer')) return 'footer';
    if (anchor.closest('.preview-card, .app-card, .card')) return 'card';
    if (anchor.closest('.cta-banner, .cta-button')) return 'cta';
    if (anchor.closest('main, #main-content')) return 'body';
    return 'other';
  }

  /** Collapse `.html` and trailing-slash variants so one page is one value. */
  function normalisePath(pathname) {
    var p = String(pathname || '').replace(/\.html$/i, '');
    if (p.length > 1) p = p.replace(/\/$/, '');
    return p || '/';
  }

  /**
   * Uncaught JS errors, so an abandoned session can be correlated with a
   * broken script. Message only — never the stack, never local variables.
   */
  window.addEventListener('error', function (evt) {
    if (!evt || !evt.message) return;
    api.trackError('window', evt.message, {
      error_source: evt.filename ? normalisePath(evt.filename) : undefined
    });
  });

  window.addEventListener('unhandledrejection', function (evt) {
    var reason = evt && evt.reason;
    var message = reason && reason.message ? reason.message : String(reason || '');
    api.trackError('promise', message);
  });

  /**
   * `app_open` fires automatically for an app's own entry page, so the eight
   * apps do not each need a line of boilerplate to report that they launched.
   *
   * Scoped to app_section === 'app' on purpose: the ~34,800 generated pages
   * under shows/ and exercises/ are static content, not app launches, and
   * counting them as such would recreate the exact distortion this whole
   * change is undoing (page-view volume from crawled static pages swamping
   * real usage).
   */
  if (APP_NAME !== 'site' && detectAppSection() === 'app') {
    api.trackAppOpen();
  }

  window.shevatoAnalytics = api;
})();
