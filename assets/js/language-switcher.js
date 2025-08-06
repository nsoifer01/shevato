function switchLanguage(lang) {
  // Update button states
  document.querySelectorAll('.lang-btn').forEach(btn => btn.classList.remove('active'));
  event.target.classList.add('active');
  
  // Hide all language content
  document.querySelectorAll('[lang]').forEach(el => el.style.display = 'none');
  
  // Show selected language content
  document.querySelectorAll(`[lang="${lang}"]`).forEach(el => {
    if (el.tagName === 'P' || el.tagName === 'H3' || el.tagName === 'DIV') {
      el.style.display = 'block';
    } else {
      el.style.display = 'inline';
    }
  });
  
  // Set page direction for Hebrew
  document.body.dir = (lang === 'he') ? 'rtl' : 'ltr';
  
  // Save preference
  localStorage.setItem('moadon-alef-lang', lang);
}

// Load saved language preference
document.addEventListener('DOMContentLoaded', function() {
  const savedLang = localStorage.getItem('moadon-alef-lang') || 'en';
  const langBtn = document.querySelector(`.lang-btn:nth-child(${savedLang === 'en' ? 1 : savedLang === 'ru' ? 2 : 3})`);
  if (langBtn) {
    langBtn.click();
  }
});