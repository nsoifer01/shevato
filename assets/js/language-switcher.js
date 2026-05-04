/**
 * Moadon Alef language switcher.
 * Buttons declare their language via `data-lang`. The function avoids
 * the non-standard global `event` object so it works under strict mode
 * and in non-Chromium browsers.
 *
 * Note: the page's `<html>` element intentionally has NO `lang` attribute.
 * A CSS rule (`[lang]:not([lang="en"]) { display: none; }`) hides per-element
 * lang variants by default; setting `<html lang="he">` would hide the
 * entire page. The chosen language is reflected via `dir` and the
 * Open Graph / hreflang tags in <head> still signal targeting to crawlers.
 */

const LANG_BLOCK_ELEMENTS = new Set(['P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'DIV', 'SECTION']);

function switchLanguage(lang) {
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
    localStorage.setItem('moadon-alef-lang', lang);
  } catch (_) {
    // localStorage may be unavailable in private browsing modes.
  }
}

document.addEventListener('DOMContentLoaded', function() {
  let savedLang = 'en';
  try {
    savedLang = localStorage.getItem('moadon-alef-lang') || 'en';
  } catch (_) {
    // ignore
  }
  switchLanguage(savedLang);
});
