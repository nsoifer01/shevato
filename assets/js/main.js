/**
 * Global Site Entry Point (ES Module)
 * Imports Firebase Auth, Auth UI, and handles site-wide initialization.
 *
 * Dependencies: jQuery (global), breakpoints.js (global), util.js (global)
 */

import { FirebaseAuth } from './firebase-auth.js';
import { AuthUI, SELECTORS } from './auth-ui.js';

const $ = window.jQuery;

/* ==========================================================================
   Site-wide Main Functionality
   ========================================================================== */

// Site variables
const $window = $(window);
const $body = $('body');

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
$window.on('load', function () {
  window.setTimeout(function () {
    $body.removeClass('is-preload');
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
  const $menu = $('#menu');
  const $menuToggle = $(SELECTORS.menuToggle);

  $menu.append('<a href="#menu" class="close"></a>').appendTo($body).panel({
    target: $body,
    visibleClass: 'is-menu-visible',
    delay: 500,
    hideOnClick: true,
    hideOnSwipe: true,
    resetScroll: true,
    resetForms: true,
    side: 'right',
  });

  // Add proper accessibility handling
  const handleMenuVisibility = () => {
    const isVisible = $body.hasClass('is-menu-visible');

    // Update aria attributes
    $menuToggle.attr('aria-expanded', isVisible);
    $menu.attr('aria-hidden', !isVisible);

    if (!isVisible) {
      // When hiding menu, remove focus from any focused elements inside
      const focusedElement = $menu.find(':focus');
      if (focusedElement.length) {
        focusedElement.blur();
        $menuToggle.focus();
      }
    }
  };

  // Watch for visibility changes
  const observer = new MutationObserver((mutations) => {
    mutations.forEach((mutation) => {
      if (mutation.attributeName === 'class') {
        handleMenuVisibility();
      }
    });
  });

  observer.observe($body[0], {
    attributes: true,
    attributeFilter: ['class'],
  });

  // Initial state
  handleMenuVisibility();
}

/* ==========================================================================
   Global Initialization
   ========================================================================== */

// Initialize all components when DOM is ready
$(document).ready(() => {
  // Initialize global instances
  window.firebaseAuth = new FirebaseAuth();
  window.authUI = new AuthUI();

  // Handle includes system
  const includes = $('[data-include]');

  jQuery.each(includes, function () {
    const includeFile = $(this).data('include') + '.html';
    const basePath = window.location.pathname.includes('/apps/') ? '../../partials/' : 'partials/';
    const file = basePath + includeFile;
    const $element = $(this);

    $element.load(file, function () {
      // Initialize menu after header is loaded
      if (includeFile === 'header.html' && $('#menu').length > 0) {
        initializeMenu();
      }

      // Initialize auth UI after header is loaded
      if (includeFile === 'header.html' && window.authUI && window.authUI.onHeaderLoaded) {
        window.authUI.onHeaderLoaded();
      }

      // Update menu toggle accessibility attributes
      if (includeFile === 'header.html') {
        const menuToggle = $(SELECTORS.menuToggle);
        const menu = $('#menu');

        if (menuToggle.length && menu.length) {
          menuToggle.attr('aria-expanded', 'false');
          menu.attr('aria-hidden', 'true');
        }
      }
    });
  });

  // Additional auth UI initialization after delay
  setTimeout(() => {
    if (
      window.authUI &&
      window.authUI.state &&
      $(SELECTORS.authContainer).length > 0 &&
      !window.authUI.state.headerLoaded
    ) {
      window.authUI.onHeaderLoaded();
    }
  }, 1000);
});

// Handle resize events (debounced for performance)
const debouncedResize = debounce(() => {
  // Handle responsive adjustments
  if (window.authUI && window.authUI.state.isModalOpen) {
    window.authUI.trapFocus = window.authUI.trapFocus.bind(window.authUI);
  }
}, 250);

$window.on('resize', debouncedResize);
