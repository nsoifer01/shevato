// Universal Authentication Header Enhancement
// This script automatically adds Firebase authentication to any page header

(function() {
  'use strict';

  // Function to create the authentication UI HTML
  function createAuthUI() {
    const authHTML = `
      <div id="auth-container" class="auth-container">
        <div class="auth-main">
          <span id="user-info" class="user-info" style="display: none;">
            <i class="fa fa-user-circle"></i>
            <span class="user-email"></span>
          </span>
          <a href="#" id="sign-in-btn" class="auth-link sign-in-btn">
            <i class="fa fa-sign-in"></i> Sign In
          </a>
          <span class="auth-separator">|</span>
          <a href="#" id="sign-up-btn" class="auth-link sign-up-btn">
            <i class="fa fa-user-plus"></i> Sign Up
          </a>
          <a href="#" id="sign-out-btn" class="auth-link sign-out-btn" style="display: none;">
            <i class="fa fa-sign-out"></i> Sign Out
          </a>
        </div>
        <div id="auth-status" class="auth-status signed-out">
          <i class="fa fa-cloud-upload"></i> Optional - Sync across devices
        </div>
      </div>
    `;
    return authHTML;
  }

  // Function to enhance header with authentication
  function enhanceHeader() {
    const header = document.getElementById('header');
    if (!header) return;

    // Check if auth container already exists
    if (header.querySelector('#auth-container')) return;

    // Find the logo element
    const logo = header.querySelector('.logo');
    const nav = header.querySelector('nav');
    
    if (logo && nav) {
      // Check if header-left wrapper already exists
      let headerLeft = header.querySelector('.header-left');
      
      if (!headerLeft) {
        // Create header-left wrapper
        headerLeft = document.createElement('div');
        headerLeft.className = 'header-left';
        
        // Move logo into header-left
        logo.parentNode.insertBefore(headerLeft, logo);
        headerLeft.appendChild(logo);
      }
      
      // Add authentication UI
      headerLeft.insertAdjacentHTML('beforeend', createAuthUI());
    }
  }

  // Function to load Firebase authentication scripts
  function loadFirebaseScripts() {
    // Check if Firebase is already loaded
    if (window.firebaseAuthLoaded) return;

    // Get the base path (handle different directory levels)
    const pathDepth = window.location.pathname.split('/').filter(p => p && p !== 'index.html').length - 1;
    const basePath = pathDepth > 0 ? '../'.repeat(pathDepth) : './';

    // Load Firebase modules
    const scripts = [
      'assets/js/firebase-config.js',
      'assets/js/firebase-auth.js',
      'assets/js/auth-ui.js'
    ];

    scripts.forEach(script => {
      const scriptElement = document.createElement('script');
      scriptElement.type = 'module';
      scriptElement.src = basePath + script;
      document.body.appendChild(scriptElement);
    });

    window.firebaseAuthLoaded = true;
  }

  // Initialize when DOM is ready
  function init() {
    enhanceHeader();
    loadFirebaseScripts();
  }

  // Handle different loading scenarios
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    // DOM is already loaded
    init();
  }

  // Also handle jQuery ready for compatibility with main.js
  if (typeof jQuery !== 'undefined') {
    jQuery(document).ready(function() {
      // Re-run in case header was modified by other scripts
      setTimeout(enhanceHeader, 100);
    });
  }

})();