/**
 * Global Enhanced JavaScript
 * Consolidated JavaScript following .claude_rules guidelines
 * Includes: Firebase Config, Auth, UI, and Main site functionality
 * 
 * Dependencies: jQuery, Firebase SDK (loaded from CDN)
 */

(function($) {
  'use strict';

  /* ==========================================================================
     Constants and Configuration
     ========================================================================== */

  const SELECTORS = {
    authContainer: '[data-js="auth-container"]',
    menuToggle: '[data-js="menu-toggle"]',
    modal: '#auth-modal',
    modalClose: '.auth-modal__close',
    tabButtons: '.auth-tab',
    forms: '.auth-form',
    signinForm: '#auth-signin-form',
    signupForm: '#auth-signup-form',
    messageContainer: '#auth-message',
    skipLink: '.skip-link'
  };

  const CSS_CLASSES = {
    modalOpen: 'auth-modal-open',
    modalVisible: 'auth-modal--visible',
    tabActive: 'auth-tab--active',
    formActive: 'auth-form--active',
    messageVisible: 'auth-message--visible',
    inputError: 'auth-form__input--error'
  };

  // Firebase config will be loaded from external file (firebase-config-local.js)
  // or from environment variables in production

  var includes = $('[data-include]');
  var includesLoaded = 0;
  var totalIncludes = includes.length;
  
  jQuery.each(includes, function(){
    var includeFile = $(this).data('include') + '.html';
    var basePath = window.location.pathname.includes('/apps/') ? '../../partials/' : 'partials/';
    var file = basePath + includeFile;
    var $element = $(this);
    
    $element.load(file, function() {
      includesLoaded++;
      // Initialize menu after header is loaded
      if (includeFile === 'header.html' && $('#menu').length > 0) {
        initializeMenu();
      }
    });
  });

  // Play initial animations on page load
  $window.on('load', function() {
    window.setTimeout(function() {
      $body.removeClass('is-preload');
    }, 100);
  });

  /**
   * Initialize menu functionality
   */
  function initializeMenu() {
    $('#menu')
      .append('<a href="#menu" class="close"></a>')
      .appendTo($body)
      .panel({
        target: $body,
        visibleClass: 'is-menu-visible',
        delay: 500,
        hideOnClick: true,
        hideOnSwipe: true,
        resetScroll: true,
        resetForms: true,
        side: 'right'
      });
  }

  /* ==========================================================================
     Global Initialization
     ========================================================================== */

  // Initialize all components when DOM is ready
  $(document).ready(() => {
    // Initialize global instances
    window.FirebaseConfig = FirebaseConfig;
    window.firebaseAuth = new FirebaseAuth();
    window.authUI = new AuthUI();

    // Handle includes system
    const includes = $('[data-include]');
    const includesLoaded = 0;

    jQuery.each(includes, function() {
      const includeFile = $(this).data('include') + '.html';
      const basePath = window.location.pathname.includes('/apps/') ? '../../partials/' : 'partials/';
      const file = basePath + includeFile;
      const $element = $(this);

      $element.load(file, function() {
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
      if (window.authUI && window.authUI.state && $(SELECTORS.authContainer).length > 0 && !window.authUI.state.headerLoaded) {
        window.authUI.onHeaderLoaded();
      }
    }, 1000);
  });

  // Handle scroll and resize events (debounced for performance)
  const debouncedResize = debounce(() => {
    // Handle responsive adjustments
    if (window.authUI && window.authUI.state.isModalOpen) {
      // Ensure modal is properly positioned
      window.authUI.trapFocus = window.authUI.trapFocus.bind(window.authUI);
    }
  }, 250);

  $window.on('resize', debouncedResize);

})(jQuery);

/* ==========================================================================
   Export for Module Systems (if needed)
   ========================================================================== */

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { FirebaseConfig, FirebaseAuth, AuthUI };
}