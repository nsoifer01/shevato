import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Shared-UI consistency guard.
//
// Headers, footers, the auth/sign-out modal, nav and other global chrome must
// be IDENTICAL on every page: one shared implementation (partials/ +
// assets/js/main.js), one shared stylesheet (assets/css/*), zero per-app
// copies or overrides. This suite fails when a page re-implements a shared
// component, restyles shared-component selectors from app CSS, or leaks
// app typography into shared components by scoping it to <body> (the exact
// mechanism that made Trip Planner's sign-out modal diverge, 2026-07-18).
//
// LEGACY debt: some older apps still scope element styling to their body
// class. They are allowlisted below so the invariant holds for every NEW
// app and every NEW rule; shrink the allowlist, never grow it.

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const APPS_DIR = join(repo, 'apps');
const apps = readdirSync(APPS_DIR, { withFileTypes: true })
  .filter((d) => d.isDirectory() && existsSync(join(APPS_DIR, d.name, 'index.html')))
  .map((d) => d.name);

const read = (p) => readFileSync(p, 'utf8');
const stripCssComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');
const stripHtmlComments = (html) => html.replace(/<!--[\s\S]*?-->/g, '');

// Flatten a stylesheet into [selector, declarations] pairs, recursing into
// @media / @supports blocks. Comment-stripped input expected.
function cssRules(css) {
  const rules = [];
  let i = 0;
  const n = css.length;
  let buf = '';
  while (i < n) {
    const ch = css[i];
    if (ch === '{') {
      const selector = buf.trim();
      buf = '';
      // find matching close brace
      let depth = 1;
      let j = i + 1;
      while (j < n && depth > 0) {
        if (css[j] === '{') depth++;
        else if (css[j] === '}') depth--;
        j++;
      }
      const body = css.slice(i + 1, j - 1);
      if (selector.startsWith('@media') || selector.startsWith('@supports')) {
        rules.push(...cssRules(body));
      } else if (!selector.startsWith('@')) {
        rules.push([selector, body]);
      }
      i = j;
    } else {
      buf += ch;
      i++;
    }
  }
  return rules;
}

function appCssFiles(app) {
  const out = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.css') && !e.name.endsWith('.min.css')) out.push(p);
    }
  };
  const cssDir = join(APPS_DIR, app, 'css');
  if (existsSync(cssDir)) walk(cssDir);
  return out;
}

// Shared chrome an app stylesheet may NEVER style, full stop.
const FORBIDDEN_TOKENS = [
  '.signout-modal', '.signout-confirm-btn', '.signout-cancel-btn',
  '.auth__', '#auth-container', '#auth-signout-btn', '.nav-apps', '#sync-banner',
];

// #header/#footer/#menu: apps may only POSITION the bare element within
// their layout (sticky footers, clearing a bottom nav). Anything else -
// descendants, typography, colors, backgrounds - is restyling shared chrome.
const LAYOUT_ONLY_RE = /^(margin[a-z-]*|padding[a-z-]*|flex|flex-[a-z]+|order|align-self|grid-row|grid-column)$/;

// Apps that still element-scope via their body class. BURN-DOWN list:
// migrate each to a root-wrapper scope (see apps/trip-planner) and remove.
const LEGACY_BODY_SCOPED = new Set([
  'arena', 'maptap-rivals', 'mario-kart', 'gym-tracker', 'football-h2h', 'rising-shows',
]);

// Inherited properties that leak from <body> into shared components
// appended to <body> (sign-out modal, toasts).
const INHERITED_LEAK_RE = /(^|;)\s*(font[a-z-]*|color|letter-spacing|text-transform|line-height|-webkit-font-smoothing|-moz-osx-font-smoothing)\s*:/;

function bodyClassesOf(app) {
  const html = stripHtmlComments(read(join(APPS_DIR, app, 'index.html')));
  const m = html.match(/<body[^>]*class="([^"]+)"/);
  return m ? m[1].split(/\s+/).filter(Boolean) : [];
}

test('every app page uses the shared header and footer includes', () => {
  for (const app of apps) {
    const html = read(join(APPS_DIR, app, 'index.html'));
    assert.ok(html.includes('data-include="header"'), `${app}: missing shared header include`);
    assert.ok(html.includes('data-include="footer"'), `${app}: missing shared footer include`);
  }
});

test('no app page re-implements shared component markup', () => {
  const violations = [];
  for (const app of apps) {
    const html = stripHtmlComments(read(join(APPS_DIR, app, 'index.html')));
    for (const token of ['class="signout-modal', 'signout-confirm-btn', 'signout-cancel-btn', 'id="header"', 'id="footer"', 'class="nav-apps']) {
      if (html.includes(token)) violations.push(`${app}/index.html contains "${token}"`);
    }
  }
  assert.deepEqual(violations, [], `Shared components come only from partials/ + assets/js/main.js:\n${violations.join('\n')}`);
});

test('app stylesheets never restyle shared chrome (modal/auth/nav; header/footer layout-positioning only)', () => {
  const violations = [];
  for (const app of apps) {
    for (const file of appCssFiles(app)) {
      const rel = file.replace(repo + '/', '');
      for (const [selector, body] of cssRules(stripCssComments(read(file)))) {
        for (const token of FORBIDDEN_TOKENS) {
          if (selector.includes(token)) violations.push(`${rel}: "${selector}" styles ${token}`);
        }
        const chromeMatch = selector.match(/#(header|footer|menu)(\b[^,{]*)/);
        if (chromeMatch) {
          const tail = chromeMatch[2].trim();
          if (tail.length > 0) {
            violations.push(`${rel}: "${selector}" reaches inside #${chromeMatch[1]}`);
          } else {
            for (const decl of body.split(';')) {
              const prop = decl.split(':')[0].trim().toLowerCase();
              if (prop && !LAYOUT_ONLY_RE.test(prop)) {
                violations.push(`${rel}: "${selector}" sets non-layout property "${prop}"`);
              }
            }
          }
        }
      }
    }
  }
  assert.deepEqual(violations, [], `Shared chrome is styled ONLY by assets/css/*:\n${violations.join('\n')}`);
});

test('body-scoped app classes never declare inherited typography (leaks into shared modals)', () => {
  const violations = [];
  for (const app of apps) {
    if (LEGACY_BODY_SCOPED.has(app)) continue; // burn-down list above
    const classes = bodyClassesOf(app);
    for (const file of appCssFiles(app)) {
      const rel = file.replace(repo + '/', '');
      for (const [selector, body] of cssRules(stripCssComments(read(file)))) {
        for (const cls of classes) {
          // bare `body.<class>` (no descendant part) with inherited props
          const bare = new RegExp(`(^|,)\\s*(html\\s+)?body\\.${cls}(\\.[a-zA-Z0-9_-]+)*\\s*$`);
          if (selector.split(',').some((s) => bare.test(s.trim())) && INHERITED_LEAK_RE.test(body)) {
            violations.push(`${rel}: "${selector}" declares inherited typography/color on <body>`);
          }
        }
      }
    }
  }
  assert.deepEqual(violations, [], `Inherited props on <body> reach the shared sign-out modal and toasts. Scope them to the app root wrapper instead:\n${violations.join('\n')}`);
});

test('non-legacy apps keep element styling off the body class entirely (root-wrapper scoping)', () => {
  const violations = [];
  for (const app of apps) {
    if (LEGACY_BODY_SCOPED.has(app)) continue;
    const classes = bodyClassesOf(app);
    for (const file of appCssFiles(app)) {
      const rel = file.replace(repo + '/', '');
      for (const [selector] of cssRules(stripCssComments(read(file)))) {
        for (const cls of classes) {
          const re = new RegExp(`body\\.${cls}[^,{]*\\s+(a|p|h[1-6]|ul|ol|li|input|select|option|textarea|button|table|form)\\b`);
          if (re.test(selector)) violations.push(`${rel}: "${selector}"`);
        }
      }
    }
  }
  assert.deepEqual(violations, [], `New apps scope element styles to a root wrapper div, never via <body> (see apps/trip-planner/css/styles.css header):\n${violations.join('\n')}`);
});

test('trip-planner keeps its scope class on the root wrapper, not <body>', () => {
  const html = read(join(APPS_DIR, 'trip-planner', 'index.html'));
  assert.match(html, /<body class="tp-page">/);
  assert.match(html, /<div class="trip-planner-app">/);
  const css = stripCssComments(read(join(APPS_DIR, 'trip-planner', 'css', 'styles.css')));
  assert.ok(!/body\.trip-planner-app/.test(css), 'styles.css must not scope to body.trip-planner-app');
});

test('main.css keeps the shared-chrome locks and the single modal stylesheet', () => {
  const css = read(join(repo, 'assets', 'css', 'main.css'));
  assert.ok(css.includes('#header,'), 'header/footer typography lock missing');
  assert.ok(css.includes('.signout-modal, .signout-modal *'), 'sign-out modal typography lock missing');
  assert.ok(css.includes('@import url(firebase-auth.css)'), 'firebase-auth.css must stay imported from main.css');
});

test('shared overlays are immune to page color-scheme and browser autofill', () => {
  // Body-appended shared overlays inherit the page's color-scheme, which
  // flips Chrome's UA rendering (autofill paint, native widgets) to dark on
  // dark app pages. The shared stylesheet must pin its own scheme and
  // override autofill paint so auth inputs render identically site-wide.
  const css = stripCssComments(read(join(repo, 'assets', 'css', 'firebase-auth.css')));
  const rules = cssRules(css);
  for (const component of ['.auth-modal', '.signout-modal']) {
    const pinned = rules.some(([sel, body]) =>
      sel.split(',').map((s) => s.trim()).includes(component) &&
      /color-scheme\s*:\s*light/.test(body));
    assert.ok(pinned, `${component} must declare color-scheme: light in firebase-auth.css`);
  }
  assert.ok(css.includes(':-webkit-autofill'), 'auth inputs must override -webkit-autofill paint');
  assert.match(css, /:-webkit-autofill[^{]*\{[^}]*box-shadow[^}]*inset/s, 'autofill override must use the inset box-shadow technique');
});

test('no app script re-implements the sign-out modal', () => {
  const violations = [];
  for (const app of apps) {
    const jsDir = join(APPS_DIR, app, 'js');
    if (!existsSync(jsDir)) continue;
    const walk = (dir) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith('.js')) {
          const src = read(p);
          if (src.includes('signout-modal') || src.includes('createSignOutModal')) {
            violations.push(p.replace(repo + '/', ''));
          }
        }
      }
    };
    walk(jsDir);
  }
  assert.deepEqual(violations, [], `Sign-out UI comes only from assets/js/main.js:\n${violations.join('\n')}`);
});
