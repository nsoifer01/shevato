// Enforce dark theme only
document.body.classList.add('dark-theme');

// Remove any light-mode classes that might exist
document.body.classList.remove('light-mode');

// Set dark theme in localStorage for consistency
localStorage.setItem('darkTheme', true);