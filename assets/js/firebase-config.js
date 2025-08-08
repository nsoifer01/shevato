// Firebase configuration with environment variables support
// For static sites, we'll use a configuration that can be injected at build time

class FirebaseConfig {
  constructor() {
    // Environment variables will be injected by build process or Netlify
    this.config = {
      apiKey: this.getEnvVar('VITE_FIREBASE_API_KEY') || this.getEnvVar('FIREBASE_API_KEY'),
      authDomain: this.getEnvVar('VITE_FIREBASE_AUTH_DOMAIN') || this.getEnvVar('FIREBASE_AUTH_DOMAIN'),
      projectId: this.getEnvVar('VITE_FIREBASE_PROJECT_ID') || this.getEnvVar('FIREBASE_PROJECT_ID'),
      storageBucket: this.getEnvVar('VITE_FIREBASE_STORAGE_BUCKET') || this.getEnvVar('FIREBASE_STORAGE_BUCKET'),
      messagingSenderId: this.getEnvVar('VITE_FIREBASE_MESSAGING_SENDER_ID') || this.getEnvVar('FIREBASE_MESSAGING_SENDER_ID'),
      appId: this.getEnvVar('VITE_FIREBASE_APP_ID') || this.getEnvVar('FIREBASE_APP_ID'),
      measurementId: this.getEnvVar('VITE_FIREBASE_MEASUREMENT_ID') || this.getEnvVar('FIREBASE_MEASUREMENT_ID')
    };
    
    // For static sites without a build process, we'll use window.firebaseConfig as fallback
    if (typeof window !== 'undefined' && window.firebaseConfig) {
      this.config = { ...this.config, ...window.firebaseConfig };
    }
    
    // For immediate testing without environment setup, allow a demo mode
    if (typeof window !== 'undefined' && window.location.hostname === 'localhost' && !this.config.apiKey) {
      // Show that the integration works but Firebase isn't configured
      this.config._demoMode = true;
    }
  }
  
  getEnvVar(name) {
    // Try different ways to access environment variables
    if (typeof process !== 'undefined' && process.env) {
      return process.env[name];
    }
    // Check for Vite-style environment variables (without using import.meta)
    if (typeof window !== 'undefined' && window.env) {
      return window.env[name];
    }
    // Check for Netlify environment variables
    if (typeof window !== 'undefined' && window.__env && window.__env[name]) {
      return window.__env[name];
    }
    return null;
  }
  
  getConfig() {
    // Validate that we have the required config
    const requiredFields = ['apiKey', 'authDomain', 'projectId'];
    const missingFields = requiredFields.filter(field => !this.config[field]);
    
    if (missingFields.length > 0) {
      console.warn('Firebase config missing required fields:', missingFields);
      console.warn('Please check your environment variables or window.firebaseConfig');
      return null;
    }
    
    // Validate config format
    if (!this.validateConfig(this.config)) {
      console.error('Invalid Firebase configuration format');
      return null;
    }
    
    return this.config;
  }
  
  /**
   * Validate Firebase configuration format
   * @private
   * @param {Object} config - Firebase configuration object
   * @returns {boolean} True if valid
   */
  validateConfig(config) {
    // Basic validation for security
    const apiKeyPattern = /^AIza[0-9A-Za-z_-]{35}$/;
    const projectIdPattern = /^[a-z0-9-]{6,30}$/;
    
    if (!apiKeyPattern.test(config.apiKey)) {
      console.error('Invalid Firebase API key format');
      return false;
    }
    
    if (!projectIdPattern.test(config.projectId)) {
      console.error('Invalid Firebase project ID format');
      return false;
    }
    
    if (!config.authDomain.includes(config.projectId)) {
      console.error('Auth domain does not match project ID');
      return false;
    }
    
    return true;
  }
  
  isConfigured() {
    return this.getConfig() !== null;
  }
}

// Export for use in other modules
window.FirebaseConfig = FirebaseConfig;