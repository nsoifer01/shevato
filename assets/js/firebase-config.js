/**
 * Firebase Configuration Loader
 * This file handles loading Firebase configuration for both local and production environments
 * 
 * Production (Netlify): Loads config from a dynamically generated endpoint
 * Local Development: Uses firebase-config-local.js if it exists
 */

(function() {
  'use strict';

  // Initialize with empty config
  window.firebaseConfig = {};

  // For local development, the config will be overridden by firebase-config-local.js
  // For production, we need to fetch the config from a Netlify Function or use a different approach
  
  // Since Netlify doesn't inject env vars into static files, we'll use a different approach
  // We'll create the config inline in the HTML using a Netlify snippet injection
  
  // This file is mainly a fallback and placeholder
  if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
    console.info('Local environment detected. Loading firebase-config-local.js...');
  } else {
    console.info('Production environment detected. Config should be injected via HTML snippet.');
  }
})();