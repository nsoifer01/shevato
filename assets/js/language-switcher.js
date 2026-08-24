/**
 * Moadon Alef language switcher.
 * Buttons declare their language via `data-lang`. Click handling is
 * delegated from `document` so the buttons need no inline `onclick`
 * attribute, which keeps the markup compatible with strict CSPs that
 * disallow inline event handlers.
 *
 * The CSS rule `[lang]:not([lang="en"]) { display: none; }` hides
 * per-element lang variants by default; the chosen language is then
 * revealed by toggling inline display below. The `<html>` and `<body>`
 * elements are skipped so a root-level `lang` attribute (required for
 * a11y / SEO) cannot blank the page.
 */

const LANG_BLOCK_ELEMENTS = new Set(['P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'DIV', 'SECTION']);
const SUPPORTED_LANGS = new Set(['en', 'ru', 'he']);
const STORAGE_KEY = 'moadon-alef-lang';

function isStructuralLangHost(el) {
  return el === document.documentElement || el === document.body;
}

function isLangContainer(el) {
  // The brand H1 carries a `lang` attribute for a11y/SEO but stays visible in
  // every language; its inner spans are the ones toggled. It is handled
  // explicitly below so the default-hide CSS rule never collapses it.
  return el.classList.contains('brand-title');
}

function switchLanguage(lang) {
  if (!SUPPORTED_LANGS.has(lang)) return;

  document.querySelectorAll('.lang-btn').forEach(btn => {
    const isActive = btn.dataset.lang === lang;
    btn.classList.toggle('active', isActive);
    btn.setAttribute('aria-pressed', isActive ? 'true' : 'false');
  });

  document.querySelectorAll('[lang]').forEach(el => {
    if (el.classList.contains('lang-btn') || isStructuralLangHost(el) || isLangContainer(el)) return;
    el.style.display = 'none';
  });

  document.querySelectorAll(`[lang="${lang}"]`).forEach(el => {
    if (el.classList.contains('lang-btn') || isStructuralLangHost(el) || isLangContainer(el)) return;
    el.style.display = LANG_BLOCK_ELEMENTS.has(el.tagName) ? 'block' : 'inline';
  });

  document.body.dir = (lang === 'he') ? 'rtl' : 'ltr';
  document.documentElement.lang = lang;

  const brandTitle = document.querySelector('h1.brand-title');
  if (brandTitle) {
    // Updating the H1's own lang would otherwise trip the default-hide CSS
    // rule for non-English; pin its display so it stays visible in every lang.
    brandTitle.lang = lang;
    brandTitle.style.display = 'block';
  }

  try {
    localStorage.setItem(STORAGE_KEY, lang);
  } catch (_) {
    // localStorage may be unavailable in private browsing modes.
  }
}

// Expose for legacy callers / tests.
window.switchLanguage = switchLanguage;

function savedLanguage() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored && SUPPORTED_LANGS.has(stored)) return stored;
  } catch (_) {
    // localStorage may be unavailable in private browsing modes.
  }
  return 'en';
}

// The footer is a partial injected by jQuery .load() in main.js AFTER
// DOMContentLoaded, so the pass below never sees it. main.js dispatches
// `shevato:include-loaded` on document for every injected partial; re-apply
// the current language then, so a persisted Hebrew/Russian choice localises
// the footer too (it used to stay English until the next button click).
document.addEventListener('shevato:include-loaded', () => {
  switchLanguage(document.documentElement.lang || savedLanguage());
});

document.addEventListener('DOMContentLoaded', () => {
  switchLanguage(savedLanguage());

  document.addEventListener('click', (event) => {
    const btn = event.target.closest('.lang-btn');
    if (!btn || !btn.dataset.lang) return;
    switchLanguage(btn.dataset.lang);
  });
});
