// Mobile Menu Management
let mobileMenuOpen = false;

function toggleMobileMenu() {
    const panel = document.getElementById('mobile-menu-panel');
    const toggle = document.querySelector('.mobile-menu-toggle');
    
    mobileMenuOpen = !mobileMenuOpen;
    
    if (mobileMenuOpen) {
        panel.classList.add('open');
        toggle.innerHTML = '×';
        toggle.style.transform = 'rotate(90deg)';
        
        // Update button states when opening
        updateMobileMenuStates();
        
        // Close menu when clicking outside
        setTimeout(() => {
            document.addEventListener('click', closeMobileMenuOnClickOutside);
        }, 100);
    } else {
        closeMobileMenu();
    }
}

function closeMobileMenu() {
    const panel = document.getElementById('mobile-menu-panel');
    const toggle = document.querySelector('.mobile-menu-toggle');
    
    panel.classList.remove('open');
    toggle.innerHTML = '☰';
    toggle.style.transform = 'rotate(0deg)';
    mobileMenuOpen = false;
    
    document.removeEventListener('click', closeMobileMenuOnClickOutside);
}

function closeMobileMenuOnClickOutside(event) {
    const panel = document.getElementById('mobile-menu-panel');
    const toggle = document.querySelector('.mobile-menu-toggle');
    
    if (!panel.contains(event.target) && !toggle.contains(event.target)) {
        closeMobileMenu();
    }
}

// Mobile menu wrapper functions
function mobileUndoAction() {
    undoLastAction();
    closeMobileMenu();
    updateMobileMenuStates();
}

function mobileRedoAction() {
    redoLastAction();
    closeMobileMenu();
    updateMobileMenuStates();
}

function mobileToggleTheme() {
    toggleTheme();
    updateMobileMenuStates();
}

function mobileToggleDate() {
    toggleDateWidget();
    closeMobileMenu();
}

function mobileTogglePlayers() {
    // Functionality removed - button does nothing
    closeMobileMenu();
}

// Update mobile menu button states based on other UI states
function updateMobileMenuStates() {
    const undoBtn = document.querySelector('.mobile-menu-panel .undo-btn');
    const redoBtn = document.querySelector('.mobile-menu-panel .redo-btn');
    const themeBtn = document.querySelector('.mobile-menu-panel .theme-btn');
    
    // Update undo/redo states
    if (undoBtn && redoBtn) {
        const mainUndoBtn = document.getElementById('undo-btn');
        const mainRedoBtn = document.getElementById('redo-btn');
        
        if (mainUndoBtn && mainRedoBtn) {
            undoBtn.disabled = mainUndoBtn.disabled;
            redoBtn.disabled = mainRedoBtn.disabled;
            
            // Update visual states
            if (undoBtn.disabled) {
                undoBtn.style.opacity = '0.5';
                undoBtn.style.cursor = 'not-allowed';
            } else {
                undoBtn.style.opacity = '1';
                undoBtn.style.cursor = 'pointer';
            }
            
            if (redoBtn.disabled) {
                redoBtn.style.opacity = '0.5';
                redoBtn.style.cursor = 'not-allowed';
            } else {
                redoBtn.style.opacity = '1';
                redoBtn.style.cursor = 'pointer';
            }
        }
    }
    
    // Update theme button icon
    if (themeBtn) {
        const isDark = document.body.classList.contains('theme');
        themeBtn.innerHTML = isDark ? '☀️' : '🌙';
        themeBtn.title = isDark ? 'Switch theme' : 'Switch theme';
    }
}

// Auto-close mobile menu on window resize to larger screens
window.addEventListener('resize', () => {
    if (window.innerWidth >= 768 && mobileMenuOpen) { // 48rem = 768px
        closeMobileMenu();
    }
});

// Initialize mobile menu state updates
document.addEventListener('DOMContentLoaded', () => {
    updateMobileMenuStates();
    
    // Update states when actions are performed
    const observer = new MutationObserver(() => {
        updateMobileMenuStates();
    });
    
    const undoBtn = document.getElementById('undo-btn');
    const redoBtn = document.getElementById('redo-btn');
    
    if (undoBtn && redoBtn) {
        observer.observe(undoBtn, { attributes: true, attributeFilter: ['disabled'] });
        observer.observe(redoBtn, { attributes: true, attributeFilter: ['disabled'] });
    }
});