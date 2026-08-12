'use strict';

// Shared footer used by every static page in this app. Inlined into the
// HTML at build time — no JS partial-include — so the cross-app links
// are visible to Googlebot and to JS-disabled visitors.
//
// The app list comes from assets/apps-manifest.json, THE canonical list:
// this file used to carry its own copy with a "keep in sync" comment, its
// sibling carried another, and hand-synced duplicates are how a new app
// ships while generated pages keep advertising the old inventory.
// sync-system/tests/app-naming-consistency.test.mjs pins this function's
// output against the manifest.

const path = require('path');
const MANIFEST = require(path.join(__dirname, '..', '..', '..', 'assets', 'apps-manifest.json'));

function renderMoreFooter() {
  const items = MANIFEST.apps
    .map((app) => `        <li><a href="/apps/${app.slug}/"><strong>${app.name}</strong><span> · ${app.blurb}</span></a></li>`)
    .join('\n');
  return `<footer class="page-footer">
    <nav class="footer-more" aria-label="More Shevato apps">
      <p class="footer-more-heading">More from Shevato</p>
      <ul>
${items}
      </ul>
    </nav>
    <p class="copyright">© Shevato LLC · <a href="/home">shevato.com</a> · <a href="/about">About</a> · <a href="/contact">Contact</a></p>
  </footer>`;
}

module.exports = { renderMoreFooter };
