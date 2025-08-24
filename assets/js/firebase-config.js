/**
 * Firebase Configuration Loader
 * This file handles loading Firebase configuration for both local and production environments
 * 
 * Production (Netlify): Loads config from Netlify Function
 * Local Development: Uses firebase-config-local.js if it exists
 */

(function() {
  'use strict';

  // Initialize with empty config
  window.firebaseConfig = {};

  // Check if running locally or in production
  const isLocal = window.location.hostname === 'localhost' || 
                  window.location.hostname === '127.0.0.1' || 
                  window.location.hostname === '0.0.0.0';

  if (isLocal) {
    console.info('Local environment detected. Config will be loaded from firebase-config-local.js');
  } else {
    console.info('Production environment detected. Loading config from Netlify Function...');
    
    // For production, load config from Netlify Function
    fetch('/.netlify/functions/firebase-config')
      .then(response => {
        if (!response.ok) {
          throw new Error(`HTTP error! status: ${response.status}`);
        }
        return response.text();
      })
      .then(configScript => {
        // Execute the returned JavaScript which sets window.firebaseConfig
        eval(configScript);
        console.info('Firebase config loaded successfully from Netlify Function');
        
        // Dispatch a custom event to notify that config is ready
        window.dispatchEvent(new CustomEvent('firebaseConfigReady', {
          detail: window.firebaseConfig
        }));
      })
      .catch(error => {
        console.error('Failed to load Firebase config from Netlify Function:', error);
        console.warn('Firebase authentication will not work without proper configuration.');
      });
  }
})();