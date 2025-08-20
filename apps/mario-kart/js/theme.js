// Apply consistent theme across the app
document.body.classList.add('theme');

// Set theme in localStorage for consistency
localStorage.setItem('theme', 'true');

// If there's a theme toggle button, hide it since we only have one theme
const themeToggle = document.getElementById('theme-toggle');
if (themeToggle) {
    themeToggle.style.display = 'none';
}