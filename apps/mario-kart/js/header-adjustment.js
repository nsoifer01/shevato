/**
 * Adjusts the main content top margin and sidebar top position based on header height
 */
function adjustContentForHeader() {
    const header = document.getElementById('header');
    const sidebar = document.getElementById('sidebar');
    const mainContent = document.getElementById('main-content');
    
    if (!header || !sidebar || !mainContent) {
        console.warn('Header, sidebar, or main content not found');
        return;
    }
    
    // Check if we're on desktop (width >= 1025px)
    const isDesktop = window.innerWidth >= 1025;
    
    // Get the actual rendered height of the header
    const headerHeight = header.getBoundingClientRect().height;
    
    if (isDesktop) {
        // Desktop: Apply margins and sticky positioning
        mainContent.style.marginTop = `${headerHeight}px`;
        
        // Update sidebar's sticky top position to account for header
        sidebar.style.top = `${headerHeight}px`;
        
        // Adjust sidebar height to fill remaining viewport
        const viewportHeight = window.innerHeight;
        const remainingHeight = viewportHeight - headerHeight;
        sidebar.style.height = `${remainingHeight}px`;
        
        // Ensure sidebar is always visible on desktop
        sidebar.classList.add('open');
        
        console.log(`Desktop: Header height: ${headerHeight}px, adjusted content margin and sidebar position`);
    } else {
        // Mobile/tablet: Reset styles for mobile behavior
        mainContent.style.marginTop = '';
        sidebar.style.top = '';
        sidebar.style.height = '';
        
        console.log(`Mobile: Reset layout styles`);
    }
}

/**
 * Debounced resize handler to improve performance
 */
let resizeTimeout;
function handleResize() {
    clearTimeout(resizeTimeout);
    resizeTimeout = setTimeout(adjustContentForHeader, 100);
}

// Initialize on DOM content loaded
document.addEventListener('DOMContentLoaded', function() {
    // Wait a bit for CSS to fully load and render
    setTimeout(adjustContentForHeader, 100);
});

// Handle window resize events
window.addEventListener('resize', handleResize);

// Handle window load event as backup
window.addEventListener('load', function() {
    setTimeout(adjustContentForHeader, 200);
});

// Also adjust when images or other content loads that might affect header height
window.addEventListener('load', adjustContentForHeader);