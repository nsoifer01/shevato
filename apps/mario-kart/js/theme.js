let isDarkTheme = true; // Default to dark mode

function toggleTheme() {
    isDarkTheme = !isDarkTheme;
    
    // Remove both classes first
    document.body.classList.remove('dark-theme', 'light-mode');
    
    // Add the appropriate class
    if (isDarkTheme) {
        document.body.classList.add('dark-theme');
    } else {
        document.body.classList.add('light-mode');
    }
    
    localStorage.setItem('darkTheme', isDarkTheme);

    // Update theme toggle icon
    const themeToggle = document.getElementById('theme-toggle');
    themeToggle.textContent = isDarkTheme ? '☀️' : '🌙';

    // Recreate charts with new theme
    if (currentView === 'trends') {
        createTrendCharts();
    } else if (currentView === 'activity') {
        createHeatmapView();
    }
}

// Load theme from localStorage
try {
    const savedTheme = localStorage.getItem('darkTheme');
    if (savedTheme === null) {
        // No saved preference, use dark mode as default
        isDarkTheme = true;
        document.body.classList.add('dark-theme');
        localStorage.setItem('darkTheme', true);
    } else if (savedTheme === 'true') {
        isDarkTheme = true;
        document.body.classList.add('dark-theme');
    } else {
        isDarkTheme = false;
        document.body.classList.add('light-mode');
    }
    // Note: theme toggle icon will be set in DOMContentLoaded
} catch (e) {
    console.error('Error loading theme:', e);
    // Fallback to dark mode on error
    isDarkTheme = true;
    document.body.classList.add('dark-theme');
}
