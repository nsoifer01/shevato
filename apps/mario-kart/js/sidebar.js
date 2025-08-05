// Sidebar functionality
let sidebarOpen = false;

function calculateLayoutHeights() {
    // Calculate footer height
    const footer = document.querySelector('[data-include="footer"]') || document.querySelector('footer');
    let footerHeight = 0;
    
    if (footer) {
        footerHeight = footer.offsetHeight;
    }
    
    // Set CSS custom properties for height calculations
    document.documentElement.style.setProperty('--footer-height', `${footerHeight}px`);
    document.documentElement.style.setProperty('--sidebar-width', getComputedStyle(document.documentElement).getPropertyValue('--sidebar-width') || '320px');
}

function initializeSidebar() {
    // Calculate layout heights first
    calculateLayoutHeights();
    
    // Prevent scroll propagation from sidebar
    const sidebar = document.getElementById('sidebar');
    if (sidebar) {
        sidebar.addEventListener('wheel', (e) => {
            e.stopPropagation();
        }, { passive: true });
        
        // Prevent touchmove from propagating on mobile
        sidebar.addEventListener('touchmove', (e) => {
            e.stopPropagation();
        }, { passive: true });
    }
    
    // Recalculate heights on window resize
    window.addEventListener('resize', () => {
        calculateLayoutHeights();
    });
    
    // Show body after initial calculations to prevent flash
    // Also wait for footer to load since it's included via data-include
    const checkFooterAndShow = () => {
        const footer = document.querySelector('[data-include="footer"]');
        if (footer && footer.innerHTML.trim()) {
            // Footer is loaded, recalculate heights
            calculateLayoutHeights();
            document.body.classList.add('loaded');
        } else {
            // Footer not loaded yet, check again
            setTimeout(checkFooterAndShow, 100);
        }
    };
    
    setTimeout(checkFooterAndShow, 50);
    
    // Small delay to ensure DOM is fully ready
    setTimeout(() => {
        // Move date filter section to sidebar
        const dateFilterSection = document.querySelector('.date-filter-section');
        const sidebarDateFilter = document.getElementById('sidebar-date-filter');
        if (dateFilterSection && sidebarDateFilter && !sidebarDateFilter.contains(dateFilterSection)) {
            // Move the date filter section (not clone, to preserve event listeners)
            sidebarDateFilter.appendChild(dateFilterSection);
            
            // Hide the h3 title within the date filter section since sidebar has its own title
            const h3Title = dateFilterSection.querySelector('h3');
            if (h3Title) {
                h3Title.style.display = 'none';
            }
        }
        
        // Move action buttons to sidebar
        const actionButtons = document.querySelector('.input-section .action-buttons');
        const sidebarActionButtons = document.getElementById('sidebar-action-buttons');
        if (actionButtons && sidebarActionButtons && !sidebarActionButtons.contains(actionButtons)) {
            // Clone the action buttons to preserve original functionality
            const buttonsClone = actionButtons.cloneNode(true);
            sidebarActionButtons.appendChild(buttonsClone);
            
            // Re-attach event handlers for cloned buttons
            const exportButton = buttonsClone.querySelector('button[onclick*="exportData"]');
            if (exportButton) {
                exportButton.onclick = () => {
                    if (typeof exportData === 'function') exportData();
                };
            }
            
            // Re-attach backup button
            const backupButton = buttonsClone.querySelector('button[onclick*="backupToGoogleDrive"]');
            if (backupButton) {
                backupButton.onclick = () => {
                    if (typeof backupToGoogleDrive === 'function') backupToGoogleDrive();
                };
            }
            
            // Remove date button from cloned action buttons since it's now in the sidebar
            const dateButton = buttonsClone.querySelector('#date-button');
            if (dateButton && dateButton.parentNode) {
                dateButton.parentNode.removeChild(dateButton);
            }
            
            // Re-attach the import file input functionality
            const importInput = buttonsClone.querySelector('#importFile');
            if (importInput) {
                importInput.id = 'importFile-sidebar';
                const importButton = buttonsClone.querySelector('button[onclick*="importFile"]');
                if (importButton) {
                    importButton.onclick = () => {
                        document.getElementById('importFile-sidebar').click();
                    };
                }
                // Re-attach change event to import input
                importInput.onchange = (event) => {
                    if (typeof importData === 'function') importData(event);
                };
            }
            
            // Hide the original action buttons
            actionButtons.style.display = 'none';
        }
    }, 100);
    
    // Sidebar stays closed on page load regardless of previous state
    // Users can manually open it if needed
    
    // Add keyboard event listeners
    document.addEventListener('keydown', handleSidebarKeyboard);
    
    // Add click listener to overlay to close sidebar when clicking outside
    const overlay = document.getElementById('sidebar-overlay');
    if (overlay) {
        overlay.addEventListener('click', closeSidebar);
    }
    
    // Handle responsive behavior
    handleResponsiveSidebar();
    window.addEventListener('resize', handleResponsiveSidebar);
}

function toggleSidebar() {
    if (sidebarOpen) {
        closeSidebar();
    } else {
        openSidebar();
    }
}

function openSidebar(animate = true) {
    // On desktop, sidebar is always visible
    if (window.innerWidth >= 1025) {
        console.log('Sidebar is always visible on desktop');
        return;
    }
    
    const sidebar = document.getElementById('sidebar');
    const overlay = document.getElementById('sidebar-overlay');
    const toggle = document.getElementById('sidebar-toggle');
    const container = document.querySelector('.main-container');
    
    sidebarOpen = true;
    
    // Update ARIA attributes if toggle exists
    if (toggle) {
        toggle.setAttribute('aria-expanded', 'true');
        // Hide toggle button
        toggle.style.opacity = '0';
        toggle.style.pointerEvents = 'none';
    }
    
    // Open sidebar
    sidebar.classList.add('open');
    if (overlay) {
        overlay.classList.add('active');
    }
    
    // Add class to prevent page scrolling
    document.body.classList.add('sidebar-open');
    
    // Save state
    localStorage.setItem('sidebarOpen', 'true');
}

function closeSidebar() {
    // Don't close sidebar on desktop (width >= 1025px)
    if (window.innerWidth >= 1025) {
        console.log('Sidebar is always visible on desktop');
        return;
    }
    
    const sidebar = document.getElementById('sidebar');
    const overlay = document.getElementById('sidebar-overlay');
    const toggle = document.getElementById('sidebar-toggle');
    const container = document.querySelector('.main-container');
    
    sidebarOpen = false;
    
    // Update ARIA attributes if toggle exists
    if (toggle) {
        toggle.setAttribute('aria-expanded', 'false');
        // Show toggle button
        toggle.style.opacity = '1';
        toggle.style.pointerEvents = 'auto';
        // Return focus to toggle button
        toggle.focus();
    }
    
    // Close sidebar
    sidebar.classList.remove('open');
    if (overlay) {
        overlay.classList.remove('active');
    }
    
    // Remove class to restore page scrolling
    document.body.classList.remove('sidebar-open');
    
    // Save state
    localStorage.setItem('sidebarOpen', 'false');
}

function handleSidebarKeyboard(event) {
    // ESC key closes sidebar
    if (event.key === 'Escape' && sidebarOpen) {
        closeSidebar();
    }
    
    // Trap focus within sidebar when open
    if (sidebarOpen && event.key === 'Tab') {
        const sidebar = document.getElementById('sidebar');
        const focusableElements = sidebar.querySelectorAll(
            'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
        );
        
        if (focusableElements.length === 0) return;
        
        const firstElement = focusableElements[0];
        const lastElement = focusableElements[focusableElements.length - 1];
        
        if (event.shiftKey && document.activeElement === firstElement) {
            event.preventDefault();
            lastElement.focus();
        } else if (!event.shiftKey && document.activeElement === lastElement) {
            event.preventDefault();
            firstElement.focus();
        }
    }
}

function handleResponsiveSidebar() {
    const container = document.querySelector('.main-container');
    const toggle = document.getElementById('sidebar-toggle');
    const sidebar = document.getElementById('sidebar');
    
    // On desktop, ensure sidebar is always visible
    if (window.innerWidth >= 1025) {
        if (sidebar) {
            sidebar.classList.add('open');
        }
    }
    // Remove any container adjustments - sidebar should overlay on mobile
}

// Touch gesture support for mobile
let touchStartX = null;
let touchEndX = null;

document.addEventListener('touchstart', (e) => {
    touchStartX = e.changedTouches[0].screenX;
}, { passive: true });

document.addEventListener('touchend', (e) => {
    touchEndX = e.changedTouches[0].screenX;
    handleSwipeGesture();
}, { passive: true });

function handleSwipeGesture() {
    if (!touchStartX || !touchEndX) return;
    
    const swipeThreshold = 50;
    const edgeSwipeZone = 20;
    
    // Swipe right from left edge to open
    if (!sidebarOpen && touchStartX < edgeSwipeZone && touchEndX > touchStartX + swipeThreshold) {
        openSidebar();
    }
    
    // Swipe left to close
    if (sidebarOpen && touchStartX > touchEndX + swipeThreshold) {
        closeSidebar();
    }
    
    // Reset values
    touchStartX = null;
    touchEndX = null;
}

// Initialize sidebar when DOM is ready
document.addEventListener('DOMContentLoaded', initializeSidebar);

// Expose functions globally for inline onclick handlers
window.toggleSidebar = toggleSidebar;
window.closeSidebar = closeSidebar;