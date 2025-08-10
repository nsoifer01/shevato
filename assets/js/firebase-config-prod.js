/**
 * Firebase Configuration for Production
 * This file provides a placeholder that will be populated by Netlify Edge Function
 * or can be modified post-deployment
 */

// Initialize empty config - will be populated by environment
window.firebaseConfig = window.firebaseConfig || {};

// Check if config was already set (by Netlify snippet or other means)
if (!window.firebaseConfig.apiKey) {
  console.warn('Firebase config not yet loaded. Waiting for environment configuration...');
  
  // Try to wait for Netlify snippet injection
  let retryCount = 0;
  const checkConfig = setInterval(() => {
    retryCount++;
    if (window.firebaseConfig && window.firebaseConfig.apiKey) {
      console.log('Firebase config loaded successfully');
      clearInterval(checkConfig);
      
      // Re-initialize Firebase if it was waiting
      if (window.firebaseAuth && window.firebaseAuth.initialize) {
        window.firebaseAuth.initialize();
      }
    } else if (retryCount > 20) {
      console.error('Firebase config not available after 2 seconds');
      clearInterval(checkConfig);
    }
  }, 100);
}