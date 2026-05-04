/**
 * Moadon Alef language switcher.
 * Buttons declare their language via `data-lang`. Click handling is
 * delegated from `document` so the buttons need no inline `onclick`
 * attribute, which keeps the markup compatible with strict CSPs that
 * disallow inline event handlers.
 *
 * Note: the page's `<html>` element intentionally has NO `lang` attribute.
 * A CSS rule (`[lang]:not([lang="en"]) { display: none; }`) hides per-element
 * lang variants by default; setting `<html lang="he">` would hide the
 * entire page. The chosen language is reflected via `dir` and the
 * Open Graph / hreflang tags in <head> still signal targeting to crawlers.
 */

const LANG_BLOCK_ELEMENTS = new Set(['P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'DIV', 'SECTION']);
const SUPPORTED_LANGS = new Set(['en', 'ru', 'he']);
const STORAGE_KEY = 'moadon-alef-lang';

function switchLanguage(lang) {
  if (!SUPPORTED_LANGS.has(lang)) return;

  document.querySelectorAll('.lang-btn').forEach(btn => {
    const isActive = btn.dataset.lang === lang;
    btn.classList.toggle('active', isActive);
    btn.setAttribute('aria-pressed', isActive ? 'true' : 'false');
  });

  // Hide every per-language element except the buttons themselves.
  document.querySelectorAll('[lang]').forEach(el => {
    if (el.classList.contains('lang-btn')) return;
    el.style.display = 'none';
  });

  document.querySelectorAll(`[lang="${lang}"]`).forEach(el => {
    if (el.classList.contains('lang-btn')) return;
    el.style.display = LANG_BLOCK_ELEMENTS.has(el.tagName) ? 'block' : 'inline';
  });

  document.body.dir = (lang === 'he') ? 'rtl' : 'ltr';

  try {
    localStorage.setItem(STORAGE_KEY, lang);
  } catch (_) {
    // localStorage may be unavailable in private browsing modes.
  }
}

// Expose for legacy callers / tests.
window.switchLanguage = switchLanguage;

document.addEventListener('DOMContentLoaded', () => {
  let savedLang = 'en';
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored && SUPPORTED_LANGS.has(stored)) savedLang = stored;
  } catch (_) {
    // ignore
  }
  switchLanguage(savedLang);

  document.addEventListener('click', (event) => {
    const btn = event.target.closest('.lang-btn');
    if (!btn || !btn.dataset.lang) return;
    switchLanguage(btn.dataset.lang);
  });
});
