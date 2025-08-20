// Custom Tooltip System for Mario Kart Race Tracker
class TooltipManager {
    constructor() {
        this.tooltipElement = null;
        this.currentTarget = null;
        this.hideTimeout = null;
        this.showTimeout = null;
        this.SHOW_DELAY = 500; // ms before showing tooltip
        this.HIDE_DELAY = 200; // ms before hiding tooltip
        this.init();
    }

    init() {
        // Create tooltip element
        this.createTooltipElement();
        
        // Set up global event listeners
        document.addEventListener('mouseover', this.handleMouseOver.bind(this));
        document.addEventListener('mouseout', this.handleMouseOut.bind(this));
        document.addEventListener('focusin', this.handleFocusIn.bind(this));
        document.addEventListener('focusout', this.handleFocusOut.bind(this));
        document.addEventListener('scroll', this.handleScroll.bind(this), true);
        window.addEventListener('resize', this.handleResize.bind(this));
        
        // Add mouseleave on document to catch when mouse leaves window
        document.addEventListener('mouseleave', () => {
            if (this.currentTarget) {
                this.hideTooltip(this.currentTarget, true);
            }
        });
        
        // Safety check: Hide tooltip if mouse moves but no element is hovered
        document.addEventListener('mousemove', (event) => {
            if (this.currentTarget && this.tooltipElement.classList.contains('visible')) {
                // Check if the current target still exists in the DOM
                if (!document.body.contains(this.currentTarget)) {
                    this.hideTooltip(this.currentTarget, true);
                    return;
                }
                
                // Check if mouse is still over the current target
                const elementAtPoint = document.elementFromPoint(event.clientX, event.clientY);
                if (!elementAtPoint || (!this.currentTarget.contains(elementAtPoint) && elementAtPoint !== this.currentTarget)) {
                    // Mouse is not over the tooltip element anymore
                    const tooltipTarget = event.target.closest('[data-tooltip], [title], [aria-label], button, .achievement-bar, .position-heat-bar, .player-name-label, .sidebar-player-initial, th[onclick]');
                    if (tooltipTarget !== this.currentTarget) {
                        this.hideTooltip(this.currentTarget, true);
                    }
                }
            }
        });
        
        // Clean up tooltips when DOM changes (e.g., when switching tabs)
        const observer = new MutationObserver(() => {
            if (this.currentTarget && !document.body.contains(this.currentTarget)) {
                this.hideTooltip(this.currentTarget, true);
            }
        });
        
        observer.observe(document.body, {
            childList: true,
            subtree: true
        });
    }

    createTooltipElement() {
        this.tooltipElement = document.createElement('div');
        this.tooltipElement.className = 'custom-tooltip';
        this.tooltipElement.setAttribute('role', 'tooltip');
        this.tooltipElement.setAttribute('aria-hidden', 'true');
        this.tooltipElement.style.position = 'absolute';
        this.tooltipElement.style.zIndex = '9999';
        this.tooltipElement.style.pointerEvents = 'none';
        document.body.appendChild(this.tooltipElement);
    }

    getTooltipContent(element) {
        // Priority order for tooltip content
        return element.getAttribute('data-tooltip') ||
               element.getAttribute('title') ||
               element.getAttribute('aria-label') ||
               element.getAttribute('alt') ||
               this.getDefaultTooltip(element);
    }

    getDefaultTooltip(element) {
        // Default tooltips based on element type or class
        const tooltipMap = {
            // Buttons
            '.theme-btn': 'Toggle light/dark theme',
            '.undo-btn': 'Undo last action',
            '.redo-btn': 'Redo last action',
            '.clear-btn': 'Clear all data',
            '.add-race-btn': 'Add new race',
            '.widget-btn.players-btn': 'Player settings',
            '.sidebar-toggle': 'Toggle sidebar',
            '.mobile-menu-toggle': 'Open menu',
            '.fab-button': 'Quick add race',
            '.close-btn': 'Close',
            '.dropdown-close': 'Close dropdown',
            '.stepper-btn': element.textContent === '+' ? 'Increase position' : 'Decrease position',
            
            // Action buttons
            'button[onclick*="exportData"]': 'Export race data to JSON file',
            'button[onclick*="importData"]': 'Import race data from file',
            'button[onclick*="backupToGoogleDrive"]': 'Download backup file',
            '.toggle-date-btn': 'Set custom race date',
            
            // Tab buttons
            '.toggle-btn:has-text("Help")': 'View help and documentation',
            '.toggle-btn:has-text("Guide")': 'Visualization guide',
            '.toggle-btn:has-text("Achievements")': 'View player achievements',
            '.toggle-btn:has-text("Stats")': 'View race statistics',
            '.toggle-btn:has-text("H2H")': 'Head-to-head comparisons',
            '.toggle-btn:has-text("Analysis")': 'Race analysis and insights',
            '.toggle-btn:has-text("Activity")': 'Race activity timeline',
            '.toggle-btn:has-text("Trends")': 'Performance trends',
            
            // Filter buttons
            '.filter-btn': `Filter: ${element.textContent}`,
            
            // Achievement bars
            '.achievement-bar': this.getAchievementTooltip(element),
            '.position-heat-bar': this.getPositionHeatTooltip(element),
            '.streak-segment': this.getStreakTooltip(element),
            '.sweet-spot-bar': this.getSweetSpotTooltip(element),
            
            // Player labels - removed tooltip for achievements section
            '.player-name-label': element.closest('#achievements-container') ? null : `${element.textContent} - Click to customize icon`,
            
            // Icons
            '.player-icon': `${element.getAttribute('data-player-name') || 'Player'} icon`,
            
            // Sidebar player icons
            '.sidebar-player-initial.clickable': 'Click to change icon',
            
            // Table headers
            'th[onclick*="sortTable"]': `Sort by ${element.textContent.replace('↕', '').trim()}`
        };

        // Check each selector
        for (const [selector, tooltip] of Object.entries(tooltipMap)) {
            if (selector.includes(':has-text(')) {
                // Handle text-based selectors
                const text = selector.match(/:has-text\("(.+?)"\)/)?.[1];
                if (text && element.textContent.includes(text)) {
                    return tooltip;
                }
            } else if (element.matches(selector)) {
                return typeof tooltip === 'function' ? tooltip : tooltip;
            }
        }

        return null;
    }

    getAchievementTooltip(element) {
        const icon = element.querySelector('.achievement-icon')?.textContent;
        const achievementMap = {
            '🔥': 'Hot Streak: Consecutive podium finishes',
            '🏆': 'Win Streak: Consecutive first place finishes', 
            '💪': 'Clutch Master: Consecutive races finishing better than average',
            '🚀': 'Momentum: Consecutive races with improving positions',
            '📅': `Perfect Day: All races in a day were top-${window.getGoodFinishThreshold ? window.getGoodFinishThreshold() : 12} finishes`
        };
        return achievementMap[icon] || 'Achievement progress';
    }

    getPositionHeatTooltip(element) {
        // The position-heat-bar element should have the full tooltip in its title attribute
        // This ensures consistency with the format set in achievements.js
        return element.getAttribute('title') || 'Position range information';
    }

    getStreakTooltip(element) {
        const isLatest = element.querySelector('.latest-badge');
        // Only show tooltip for the latest race
        if (!isLatest) return null;
        return 'Latest race';
    }

    getSweetSpotTooltip(element) {
        const number = element.querySelector('.spot-number')?.textContent;
        const opacity = parseFloat(window.getComputedStyle(element).opacity);
        if (opacity > 0.3) {
            return `Position ${number}: Frequently finished here`;
        }
        return `Position ${number}: Rarely finished here`;
    }

    showTooltip(element) {
        const content = this.getTooltipContent(element);
        if (!content) return;

        // If we're already showing a tooltip for a different element, hide it first
        if (this.currentTarget && this.currentTarget !== element) {
            this.hideTooltip(this.currentTarget, true);
        }

        // Clear any existing timeouts
        this.clearTimeouts();

        // Store title attribute temporarily and remove it to prevent browser tooltip
        if (element.hasAttribute('title')) {
            element.setAttribute('data-original-title', element.getAttribute('title'));
            element.removeAttribute('title');
        }

        this.showTimeout = setTimeout(() => {
            // Double-check the element is still being hovered
            const elementAtPoint = document.elementFromPoint(
                element.getBoundingClientRect().left + element.offsetWidth / 2,
                element.getBoundingClientRect().top + element.offsetHeight / 2
            );
            
            if (!element.contains(elementAtPoint) && elementAtPoint !== element) {
                // Element is no longer hovered, don't show tooltip
                return;
            }
            
            this.currentTarget = element;
            this.tooltipElement.textContent = content;
            this.tooltipElement.setAttribute('aria-hidden', 'false');
            this.tooltipElement.classList.add('visible');

            // Set aria-describedby
            const tooltipId = 'tooltip-' + Date.now();
            this.tooltipElement.id = tooltipId;
            element.setAttribute('aria-describedby', tooltipId);

            this.positionTooltip(element);
        }, this.SHOW_DELAY);
    }

    hideTooltip(element, immediate = false) {
        this.clearTimeouts();

        const hide = () => {
            if (this.currentTarget === element) {
                this.tooltipElement.classList.remove('visible');
                this.tooltipElement.setAttribute('aria-hidden', 'true');
                
                // Remove aria-describedby
                if (element) {
                    element.removeAttribute('aria-describedby');
                    
                    // Restore title attribute if it was removed
                    if (element.hasAttribute('data-original-title')) {
                        element.setAttribute('title', element.getAttribute('data-original-title'));
                        element.removeAttribute('data-original-title');
                    }
                }
                
                this.currentTarget = null;
            }
        };

        if (immediate) {
            hide();
        } else {
            this.hideTimeout = setTimeout(hide, this.HIDE_DELAY);
        }
    }

    positionTooltip(element) {
        const rect = element.getBoundingClientRect();
        const tooltipRect = this.tooltipElement.getBoundingClientRect();
        
        // Default position: above the element
        let top = rect.top - tooltipRect.height - 8;
        let left = rect.left + (rect.width - tooltipRect.width) / 2;
        
        // Adjust if tooltip would go off-screen
        if (top < 5) {
            // Position below instead
            top = rect.bottom + 8;
        }
        
        if (left < 5) {
            left = 5;
        } else if (left + tooltipRect.width > window.innerWidth - 5) {
            left = window.innerWidth - tooltipRect.width - 5;
        }
        
        this.tooltipElement.style.top = `${top + window.scrollY}px`;
        this.tooltipElement.style.left = `${left + window.scrollX}px`;
    }

    clearTimeouts() {
        if (this.showTimeout) {
            clearTimeout(this.showTimeout);
            this.showTimeout = null;
        }
        if (this.hideTimeout) {
            clearTimeout(this.hideTimeout);
            this.hideTimeout = null;
        }
    }

    handleMouseOver(event) {
        const element = event.target.closest('[data-tooltip], [title], [aria-label], button, .achievement-bar, .position-heat-bar, .player-name-label, .sidebar-player-initial, th[onclick]');
        if (element && !element.disabled) {
            // Only show tooltip if we're not already showing it for this element
            if (this.currentTarget !== element) {
                this.showTooltip(element);
            }
        }
    }

    handleMouseOut(event) {
        const element = event.target.closest('[data-tooltip], [title], [aria-label], button, .achievement-bar, .position-heat-bar, .player-name-label, .sidebar-player-initial, th[onclick]');
        if (element) {
            // Check if we're moving to a child element or within the same tooltip element
            const relatedTarget = event.relatedTarget;
            if (relatedTarget && element.contains(relatedTarget)) {
                // We're still within the same tooltip element, don't hide
                return;
            }
            this.hideTooltip(element);
        }
    }

    handleFocusIn(event) {
        const element = event.target;
        if (element.matches('[data-tooltip], [title], [aria-label], button, .achievement-bar, .position-heat-bar, .player-name-label, .sidebar-player-initial, th[onclick]') && !element.disabled) {
            this.showTooltip(element);
        }
    }

    handleFocusOut(event) {
        const element = event.target;
        this.hideTooltip(element);
    }

    handleScroll() {
        if (this.currentTarget) {
            // Hide tooltip immediately on scroll to prevent stuck tooltips
            this.hideTooltip(this.currentTarget, true);
        }
    }

    handleResize() {
        if (this.currentTarget) {
            // Hide tooltip immediately on resize to prevent positioning issues
            this.hideTooltip(this.currentTarget, true);
        }
    }

    // Method to add custom tooltips programmatically
    addTooltip(element, content) {
        element.setAttribute('data-tooltip', content);
    }

    // Method to update tooltip content
    updateTooltip(element, content) {
        element.setAttribute('data-tooltip', content);
        if (this.currentTarget === element && this.tooltipElement.classList.contains('visible')) {
            this.tooltipElement.textContent = content;
        }
    }
}

// Initialize tooltip manager when DOM is ready
let tooltipManager;
document.addEventListener('DOMContentLoaded', () => {
    tooltipManager = new TooltipManager();
    
    // Export for use in other modules
    window.tooltipManager = tooltipManager;
});
