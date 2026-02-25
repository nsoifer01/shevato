/**
 * Global Site Entry Point (ES Module)
 * Imports Firebase Auth, Auth UI, and handles site-wide initialization.
 *
 * Dependencies: breakpoints.js (global)
 */

import { FirebaseAuth } from './firebase-auth.js';
import { AuthUI, SELECTORS } from './auth-ui.js';
import { Panel } from './util.js';

/* ==========================================================================
   Site-wide Main Functionality
   ========================================================================== */

// Breakpoints configuration
breakpoints({
  default: ['1681px', null],
  xlarge: ['1281px', '1680px'],
  large: ['981px', '1280px'],
  medium: ['737px', '980px'],
  small: ['481px', '736px'],
  xsmall: ['361px', '480px'],
  xxsmall: [null, '360px'],
});

// Play initial animations on page load
window.addEventListener('load', () => {
  setTimeout(() => {
    document.body.classList.remove('is-preload');
  }, 100);
});

/**
 * Debounce function to limit function calls
 * @param {Function} func - Function to debounce
 * @param {number} wait - Wait time in milliseconds
 * @returns {Function} Debounced function
 */
function debounce(func, wait) {
  let timeout;
  return function executedFunction(...args) {
    const later = () => {
      clearTimeout(timeout);
      func(...args);
    };
    clearTimeout(timeout);
    timeout = setTimeout(later, wait);
  };
}

/**
 * Initialize menu functionality
 */
function initializeMenu() {
  const menu = document.getElementById('menu');
  const menuToggle = document.querySelector(SELECTORS.menuToggle);
  if (!menu) return;

  // Append close link and move menu to body
  const closeLink = document.createElement('a');
  closeLink.href = '#menu';
  closeLink.className = 'close';
  menu.appendChild(closeLink);
  document.body.appendChild(menu);

  // Create panel
  new Panel(menu, {
    target: document.body,
    visibleClass: 'is-menu-visible',
    delay: 500,
    hideOnClick: true,
    hideOnSwipe: true,
    hideOnEscape: true,
    resetScroll: true,
    resetForms: true,
    side: 'right',
  });

  // Accessibility handling
  const handleMenuVisibility = () => {
    const isVisible = document.body.classList.contains('is-menu-visible');

    if (menuToggle) {
      menuToggle.setAttribute('aria-expanded', isVisible);
    }
    menu.setAttribute('aria-hidden', !isVisible);

    if (!isVisible) {
      const focusedElement = menu.querySelector(':focus');
      if (focusedElement) {
        focusedElement.blur();
        if (menuToggle) menuToggle.focus();
      }
    }
  };

  const observer = new MutationObserver((mutations) => {
    mutations.forEach((mutation) => {
      if (mutation.attributeName === 'class') {
        handleMenuVisibility();
      }
    });
  });

  observer.observe(document.body, {
    attributes: true,
    attributeFilter: ['class'],
  });

  handleMenuVisibility();
}

/* ==========================================================================
   Global Initialization
   ========================================================================== */

document.addEventListener('DOMContentLoaded', () => {
  // Initialize global instances
  window.firebaseAuth = new FirebaseAuth();
  window.authUI = new AuthUI();

  // Handle includes system
  const includes = document.querySelectorAll('[data-include]');

  includes.forEach((el) => {
    const includeFile = el.dataset.include + '.html';
    const basePath = window.location.pathname.includes('/apps/') ? '../../partials/' : 'partials/';
    const file = basePath + includeFile;

    fetch(file)
      .then((r) => {
        if (!r.ok) throw new Error(r.statusText);
        return r.text();
      })
      .then((html) => {
        el.innerHTML = html;

        // Initialize menu after header is loaded
        if (includeFile === 'header.html' && document.getElementById('menu')) {
          initializeMenu();
        }

        // Initialize auth UI after header is loaded
        if (includeFile === 'header.html' && window.authUI && window.authUI.onHeaderLoaded) {
          window.authUI.onHeaderLoaded();
        }

        // Update menu toggle accessibility attributes
        if (includeFile === 'header.html') {
          const menuToggle = document.querySelector(SELECTORS.menuToggle);
          const menu = document.getElementById('menu');

          if (menuToggle && menu) {
            menuToggle.setAttribute('aria-expanded', 'false');
            menu.setAttribute('aria-hidden', 'true');
          }
        }
      })
      .catch(() => {
        // Silently fail - partial not found
      });
  });

  // Additional auth UI initialization after delay
  setTimeout(() => {
    if (
      window.authUI &&
      window.authUI.state &&
      document.querySelector(SELECTORS.authContainer) &&
      !window.authUI.state.headerLoaded
    ) {
      window.authUI.onHeaderLoaded();
    }
  }, 1000);
});

// Handle resize events (debounced for performance)
const debouncedResize = debounce(() => {
  if (window.authUI && window.authUI.state.isModalOpen) {
    window.authUI.trapFocus = window.authUI.trapFocus.bind(window.authUI);
  }
}, 250);

window.addEventListener('resize', debouncedResize);
