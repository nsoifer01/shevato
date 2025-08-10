/**
 * Firebase Configuration Loader
 * Dynamically loads the appropriate config based on environment
 */

(function() {
  'use strict';
  
  const isLocal = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
  
  if (!isLocal) {
    // Production: Load generated config
    const script = document.createElement('script');
    script.src = '/assets/js/firebase-config-generated.js';
    script.onerror = function() {
      console.warn('Firebase config not found. Auth features will be disabled.');
    };
    document.head.appendChild(script);
  }
  
  // Local: firebase-config-local.js is already loaded via HTML
})();