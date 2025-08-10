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

  /* ==========================================================================
     Utility Functions
     ========================================================================== */

  /**
   * Escape HTML entities to prevent XSS
   * @param {string} text - Text to escape
   * @returns {string} Escaped text
   */
  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  /**
   * Validate email address format
   * @param {string} email - Email address to validate
   * @returns {boolean} True if valid
   */
  function isValidEmail(email) {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(email);
  }

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

  /* ==========================================================================
     Firebase Configuration Class
     ========================================================================== */

  class FirebaseConfig {
    constructor() {
      this.config = {};
      
      // Try to get from environment variables or window object
      this.loadFromEnvironment();
    }

    /**
     * Dynamically load Firebase config from appropriate source
     * @static
     */
    static loadConfigScript() {
      if (typeof window === 'undefined') return;
      
      // Dynamic path resolution based on current location
      var basePath = window.location.pathname.includes('/apps/') ? '../../assets/js/' : 'assets/js/';
      
      // Try local config first, fallback to Netlify function
      const localScript = document.createElement('script');
      localScript.src = basePath + 'firebase-config-local.js';
      localScript.async = false;
      
      localScript.onerror = function() {
        const netlifyScript = document.createElement('script');
        netlifyScript.src = '/.netlify/functions/firebase-config';
        netlifyScript.async = false;
        netlifyScript.onerror = function() {
          console.warn('Firebase config could not be loaded from any source');
        };
        document.head.appendChild(netlifyScript);
      };
      
      document.head.appendChild(localScript);
    }

    /**
     * Load configuration from environment variables
     * @private
     */
    loadFromEnvironment() {
      const envVars = [
        'VITE_FIREBASE_API_KEY', 'FIREBASE_API_KEY',
        'VITE_FIREBASE_AUTH_DOMAIN', 'FIREBASE_AUTH_DOMAIN',
        'VITE_FIREBASE_PROJECT_ID', 'FIREBASE_PROJECT_ID',
        'VITE_FIREBASE_STORAGE_BUCKET', 'FIREBASE_STORAGE_BUCKET',
        'VITE_FIREBASE_MESSAGING_SENDER_ID', 'FIREBASE_MESSAGING_SENDER_ID',
        'VITE_FIREBASE_APP_ID', 'FIREBASE_APP_ID',
        'VITE_FIREBASE_MEASUREMENT_ID', 'FIREBASE_MEASUREMENT_ID'
      ];

      // Try different ways to access environment variables
      envVars.forEach(varName => {
        const value = this.getEnvVar(varName);
        if (value) {
          const configKey = this.getConfigKey(varName);
          if (configKey) {
            this.config[configKey] = value;
          }
        }
      });

      // Fallback to window.firebaseConfig if available
      if (typeof window !== 'undefined' && window.firebaseConfig) {
        this.config = { ...this.config, ...window.firebaseConfig };
      }
    }

    /**
     * Get environment variable value
     * @private
     * @param {string} name - Variable name
     * @returns {string|null} Variable value or null
     */
    getEnvVar(name) {
      if (typeof process !== 'undefined' && process.env) {
        return process.env[name];
      }
      if (typeof window !== 'undefined' && window.env) {
        return window.env[name];
      }
      if (typeof window !== 'undefined' && window.__env) {
        return window.__env[name];
      }
      return null;
    }

    /**
     * Map environment variable name to config key
     * @private
     * @param {string} envName - Environment variable name
     * @returns {string|null} Config key or null
     */
    getConfigKey(envName) {
      const mapping = {
        'VITE_FIREBASE_API_KEY': 'apiKey',
        'FIREBASE_API_KEY': 'apiKey',
        'VITE_FIREBASE_AUTH_DOMAIN': 'authDomain',
        'FIREBASE_AUTH_DOMAIN': 'authDomain',
        'VITE_FIREBASE_PROJECT_ID': 'projectId',
        'FIREBASE_PROJECT_ID': 'projectId',
        'VITE_FIREBASE_STORAGE_BUCKET': 'storageBucket',
        'FIREBASE_STORAGE_BUCKET': 'storageBucket',
        'VITE_FIREBASE_MESSAGING_SENDER_ID': 'messagingSenderId',
        'FIREBASE_MESSAGING_SENDER_ID': 'messagingSenderId',
        'VITE_FIREBASE_APP_ID': 'appId',
        'FIREBASE_APP_ID': 'appId',
        'VITE_FIREBASE_MEASUREMENT_ID': 'measurementId',
        'FIREBASE_MEASUREMENT_ID': 'measurementId'
      };
      return mapping[envName] || null;
    }

    /**
     * Validate Firebase configuration format
     * @private
     * @param {Object} config - Firebase configuration object
     * @returns {boolean} True if valid
     */
    validateConfig(config) {
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

    /**
     * Get validated Firebase configuration
     * @returns {Object|null} Firebase config or null if invalid
     */
    getConfig() {
      const requiredFields = ['apiKey', 'authDomain', 'projectId'];
      const missingFields = requiredFields.filter(field => !this.config[field]);

      if (missingFields.length > 0) {
        console.warn('Firebase config missing required fields:', missingFields);
        return null;
      }

      if (!this.validateConfig(this.config)) {
        console.error('Invalid Firebase configuration format');
        return null;
      }

      return this.config;
    }

    /**
     * Check if Firebase is configured
     * @returns {boolean} True if configured
     */
    isConfigured() {
      return this.getConfig() !== null;
    }
  }

  /* ==========================================================================
     Firebase Authentication Class
     ========================================================================== */

  class FirebaseAuth {
    constructor() {
      this.auth = null;
      this.user = null;
      this.initialized = false;
      this.authStateChangeListeners = [];
      
      // Initialize after delay to ensure dependencies are loaded
      setTimeout(() => {
        this.initialize();
      }, 500);
    }

    /**
     * Initialize Firebase authentication
     * @async
     */
    async initialize() {
      try {
        // Check dependencies
        if (typeof window.FirebaseConfig === 'undefined') {
          console.warn('FirebaseConfig not available. Retrying...');
          setTimeout(() => this.initialize(), 1000);
          return;
        }

        if (typeof firebase === 'undefined') {
          console.warn('Firebase SDK not available. Retrying...');
          setTimeout(() => this.initialize(), 1000);
          return;
        }

        const firebaseConfig = new window.FirebaseConfig();
        const config = firebaseConfig.getConfig();

        if (!config) {
          console.warn('Firebase configuration not available. Authentication disabled.');
          return;
        }

        // Initialize Firebase app
        const app = firebase.initializeApp(config);
        this.auth = firebase.auth();

        // Set up auth state listener
        this.auth.onAuthStateChanged((user) => {
          this.user = user;
          this.notifyAuthStateChange(user);
        });

        this.initialized = true;
        console.log('Firebase Auth initialized successfully');

      } catch (error) {
        console.error('Failed to initialize Firebase Auth:', error);
      }
    }

    /**
     * Add auth state change listener
     * @param {Function} callback - Callback function
     */
    onAuthStateChange(callback) {
      this.authStateChangeListeners.push(callback);
      if (this.initialized) {
        callback(this.user);
      }
    }

    /**
     * Notify all auth state change listeners
     * @private
     * @param {Object|null} user - Firebase user object
     */
    notifyAuthStateChange(user) {
      this.authStateChangeListeners.forEach(callback => {
        try {
          callback(user);
        } catch (error) {
          console.error('Auth state change listener error:', error);
        }
      });
    }

    /**
     * Sign up with email and password
     * @async
     * @param {string} email - Email address
     * @param {string} password - Password
     * @returns {Object} Firebase user object
     */
    async signUp(email, password) {
      if (!this.initialized) {
        throw new Error('Firebase Auth not initialized');
      }

      try {
        const userCredential = await this.auth.createUserWithEmailAndPassword(email, password);
        return userCredential.user;
      } catch (error) {
        console.error('Sign up error:', error);
        throw this.formatAuthError(error);
      }
    }

    /**
     * Sign in with email and password
     * @async
     * @param {string} email - Email address
     * @param {string} password - Password
     * @returns {Object} Firebase user object
     */
    async signIn(email, password) {
      if (!this.initialized) {
        throw new Error('Firebase Auth not initialized');
      }

      try {
        const userCredential = await this.auth.signInWithEmailAndPassword(email, password);
        return userCredential.user;
      } catch (error) {
        console.error('Sign in error:', error);
        throw this.formatAuthError(error);
      }
    }



    /**
     * Sign out current user
     * @async
     */
    async signOut() {
      if (!this.initialized) {
        throw new Error('Firebase Auth not initialized');
      }

      try {
        await this.auth.signOut();
      } catch (error) {
        console.error('Sign out error:', error);
        throw error;
      }
    }

    /**
     * Get current user
     * @returns {Object|null} Current user or null
     */
    getCurrentUser() {
      return this.user;
    }

    /**
     * Check if user is signed in
     * @returns {boolean} True if signed in
     */
    isSignedIn() {
      return this.user !== null;
    }

    /**
     * Format Firebase auth errors for user display
     * @private
     * @param {Error} error - Firebase error
     * @returns {Error} Formatted error
     */
    formatAuthError(error) {
      const errorMessages = {
        'auth/user-not-found': 'No account found with this email address.',
        'auth/wrong-password': 'Incorrect password.',
        'auth/invalid-login-credentials': 'Invalid email or password. Please check your credentials and try again.',
        'auth/email-already-in-use': 'An account with this email already exists.',
        'auth/weak-password': 'Password should be at least 6 characters.',
        'auth/invalid-email': 'Please enter a valid email address.',
        'auth/too-many-requests': 'Too many failed attempts. Please try again later.',
      };

      return new Error(errorMessages[error.code] || error.message);
    }

    /**
     * Check if Firebase Auth is available
     * @returns {boolean} True if available
     */
    isAvailable() {
      return this.initialized;
    }
  }

  /* ==========================================================================
     Authentication UI Class
     ========================================================================== */

  class AuthUI {
    constructor() {
      this.state = {
        isModalOpen: false,
        currentUser: null,
        headerLoaded: false,
        currentTab: 'signin'
      };

      this.elements = {};
      this.init();
    }

    /**
     * Initialize AuthUI
     * @private
     */
    init() {
      this.setupEventListeners();
      this.waitForHeader();

      if (window.firebaseAuth) {
        window.firebaseAuth.onAuthStateChange(user => this.handleAuthStateChange(user));
      }
    }

    /**
     * Set up global event listeners
     * @private
     */
    setupEventListeners() {
      $(document).ready(() => {
        this.createAuthModal();
        this.bindModalEvents();
        this.setupKeyboardHandlers();
      });
    }

    /**
     * Set up keyboard accessibility handlers
     * @private
     */
    setupKeyboardHandlers() {
      $(document).on('keydown', (event) => {
        if (event.key === 'Escape' && this.state.isModalOpen) {
          this.hideAuthModal();
        }
      });

      $(document).on('keydown', (event) => {
        if (this.state.isModalOpen && event.key === 'Tab') {
          this.trapFocus(event);
        }
      });
    }

    /**
     * Trap focus within modal
     * @private
     * @param {KeyboardEvent} event - Keyboard event
     */
    trapFocus(event) {
      const modal = document.querySelector(SELECTORS.modal);
      if (!modal) return;

      const focusableElements = modal.querySelectorAll(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
      );
      const firstElement = focusableElements[0];
      const lastElement = focusableElements[focusableElements.length - 1];

      if (event.shiftKey && document.activeElement === firstElement) {
        event.preventDefault();
        lastElement.focus();
      } else if (!event.shiftKey && document.activeElement === lastElement) {
        event.preventDefault();
        firstElement.focus();
      }
    }

    /**
     * Wait for header to be loaded
     * @private
     */
    waitForHeader() {
      const checkHeader = () => {
        const authContainer = $(SELECTORS.authContainer);
        if (authContainer.length > 0) {
          this.state.headerLoaded = true;
          this.cacheElements();
          this.updateHeaderUI();
          return;
        }
        setTimeout(checkHeader, 100);
      };
      checkHeader();
    }

    /**
     * Cache DOM elements for performance
     * @private
     */
    cacheElements() {
      this.elements = {
        authContainer: $(SELECTORS.authContainer),
        menuToggle: $(SELECTORS.menuToggle)
      };
    }

    /**
     * Called when header is loaded (from main.js)
     * @public
     */
    onHeaderLoaded() {
      this.state.headerLoaded = true;
      this.cacheElements();
      this.updateHeaderUI();
    }

    /**
     * Handle Firebase auth state changes
     * @private
     * @param {Object|null} user - Firebase user object
     */
    handleAuthStateChange(user) {
      this.state.currentUser = user;
      if (this.state.headerLoaded) {
        this.updateHeaderUI();
      }
    }

    /**
     * Update header authentication UI
     * @private
     */
    updateHeaderUI() {
      if (!this.elements.authContainer?.length || !this.state.headerLoaded) {
        return;
      }

      if (!this.isAuthAvailable()) {
        this.renderSignInButton();
        this.bindHeaderEvents();
        return;
      }

      if (this.state.currentUser) {
        this.renderUserInfo();
      } else {
        this.renderSignInButton();
      }

      this.bindHeaderEvents();
    }

    /**
     * Render signed-in user information
     * @private
     */
    renderUserInfo() {
      const displayName = this.state.currentUser.displayName || this.state.currentUser.email;
      const safeDisplayName = escapeHtml(displayName);

      this.elements.authContainer.html(`
        <div class="auth__user" role="group" aria-label="User account">
          <span class="auth__user-name" title="${safeDisplayName}">${safeDisplayName}</span>
          <button 
            id="auth-signout-btn" 
            class="auth__button auth__button--signout" 
            type="button"
            aria-label="Sign out of your account"
          >
            Sign Out
          </button>
        </div>
      `);
    }

    /**
     * Render sign-in button
     * @private
     */
    renderSignInButton() {
      this.elements.authContainer.html(`
        <div class="auth__signin-prompt">
          <button 
            id="auth-signin-btn" 
            class="auth__button" 
            type="button"
            aria-label="Sign in to your account"
          >
            Sign In
          </button>
        </div>
      `);
    }

    /**
     * Bind header event handlers
     * @private
     */
    bindHeaderEvents() {
      $('#auth-signin-btn').off('click.authui').on('click.authui', (event) => {
        event.preventDefault();
        this.showAuthModal();
      });

      $('#auth-signout-btn').off('click.authui').on('click.authui', async (event) => {
        event.preventDefault();
        await this.handleSignOut();
      });
    }

    /**
     * Handle user sign out
     * @private
     * @async
     */
    async handleSignOut() {
      // Show confirmation dialog
      this.showSignOutConfirmation();
    }

    /**
     * Show sign out confirmation modal
     * @private
     */
    showSignOutConfirmation() {
      this.createSignOutModal();
      $('.signout-modal').addClass('signout-modal--visible');
      $('body').addClass('signout-modal-open');
      
      setTimeout(() => {
        const confirmButton = $('.signout-modal').find('.signout-confirm-btn');
        if (confirmButton.length) {
          confirmButton.focus();
        }
      }, 100);
    }

    /**
     * Actually perform the sign out
     * @private
     * @async
     */
    async performSignOut() {
      try {
        await window.firebaseAuth.signOut();
        this.hideSignOutConfirmation();
        // No success message needed - the UI change is confirmation enough
      } catch (error) {
        console.error('Sign out error:', error);
        this.hideSignOutConfirmation();
        this.showMessage('Error signing out. Please try again.', 'error');
      }
    }

    /**
     * Hide sign out confirmation modal
     * @private
     */
    hideSignOutConfirmation() {
      $('.signout-modal').removeClass('signout-modal--visible');
      $('body').removeClass('signout-modal-open');
      $(document).off('keydown.signout');
      
      // Remove modal after animation
      setTimeout(() => {
        $('.signout-modal').remove();
      }, 300);
    }

    /**
     * Create sign out confirmation modal
     * @private
     */
    createSignOutModal() {
      // Remove existing modal if present
      $('.signout-modal').remove();
      
      const modalHtml = `
        <div class="signout-modal" role="dialog" aria-modal="true" aria-labelledby="signout-modal-title">
          <div class="signout-modal__content">
            <div class="signout-modal__header">
              <div class="signout-modal__icon">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <path d="M9 21H5C4.46957 21 3.96086 20.7893 3.58579 20.4142C3.21071 20.0391 3 19.5304 3 19V5C3 4.46957 3.21071 3.96086 3.58579 3.58579C3.96086 3.21071 4.46957 3 5 3H9M16 17L21 12M21 12L16 7M21 12H9" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                </svg>
              </div>
              <h2 id="signout-modal-title" class="signout-modal__title">Sign Out</h2>
            </div>
            
            <div class="signout-modal__body">
              <p class="signout-modal__message">Are you sure you want to sign out? You'll lose access to synced data across devices.</p>
            </div>
            
            <div class="signout-modal__actions">
              <button class="signout-confirm-btn" type="button">Sign Out</button>
              <button class="signout-cancel-btn" type="button">Cancel</button>
            </div>
          </div>
        </div>
      `;
      
      $('body').append(modalHtml);
      
      // Bind events
      $('.signout-cancel-btn, .signout-modal').on('click', (event) => {
        if (event.target === event.currentTarget) {
          this.hideSignOutConfirmation();
        }
      });
      
      $('.signout-confirm-btn').on('click', () => {
        this.performSignOut();
      });
      
      // Keyboard handler
      $(document).on('keydown.signout', (event) => {
        if (event.key === 'Escape') {
          this.hideSignOutConfirmation();
          $(document).off('keydown.signout');
        }
      });
    }

    // ... (Additional methods continue - createAuthModal, bindModalEvents, etc.)
    // Due to length constraints, I'll continue with the most essential methods

    /**
     * Create authentication modal
     * @private
     */
    createAuthModal() {
      const modalHtml = `
        <div id="auth-modal" class="auth-modal" role="dialog" aria-modal="true" aria-labelledby="auth-modal-title">
          <div class="auth-modal__content">
            <div class="auth-modal__header">
              <h2 id="auth-modal-title" class="auth-modal__title">Sign In to Sync Your Progress</h2>
              <button class="auth-modal__close" type="button" aria-label="Close authentication modal">
                <span aria-hidden="true">&times;</span>
              </button>
            </div>
            
            <div class="auth-sync">
              <p class="auth-sync__text">
                <strong>Signing in is optional!</strong> Your progress is automatically saved in your browser. 
                Sign in only if you want to sync your progress across multiple devices.
              </p>
            </div>
            
            <div class="auth-tabs" role="tablist" aria-label="Authentication options">
              <button class="auth-tab auth-tab--active" data-tab="signin" role="tab" aria-selected="true">Sign In</button>
              <button class="auth-tab" data-tab="signup" role="tab" aria-selected="false">Sign Up</button>
            </div>
            
            <div class="auth-content">
              <div id="auth-signin-form" class="auth-form auth-form--active" role="tabpanel">
                <form novalidate>
                  <div class="auth-form__field">
                    <label for="signin-email" class="sr-only">Email address</label>
                    <input type="email" id="signin-email" class="auth-form__input" placeholder="Email" autocomplete="email" required>
                    <div id="signin-email-error" class="auth-form__error" role="alert"></div>
                  </div>
                  <div class="auth-form__field">
                    <label for="signin-password" class="sr-only">Password</label>
                    <input type="password" id="signin-password" class="auth-form__input" placeholder="Password" autocomplete="current-password" required>
                    <div id="signin-password-error" class="auth-form__error" role="alert"></div>
                  </div>
                  <button type="submit" class="auth-form__button">Sign In</button>
                </form>
                
              </div>
              
              <div id="auth-signup-form" class="auth-form" role="tabpanel" aria-hidden="true">
                <form novalidate>
                  <div class="auth-form__field">
                    <label for="signup-email" class="sr-only">Email address</label>
                    <input type="email" id="signup-email" class="auth-form__input" placeholder="Email" autocomplete="email" required>
                    <div id="signup-email-error" class="auth-form__error" role="alert"></div>
                  </div>
                  <div class="auth-form__field">
                    <label for="signup-password" class="sr-only">Password (minimum 6 characters)</label>
                    <input type="password" id="signup-password" class="auth-form__input" placeholder="Password (min 6 characters)" autocomplete="new-password" minlength="6" required>
                    <div id="signup-password-error" class="auth-form__error" role="alert"></div>
                  </div>
                  <button type="submit" class="auth-form__button">Create Account</button>
                </form>
                
              </div>
            </div>
            
            <div id="auth-message" class="auth-message" role="alert" aria-live="polite"></div>
          </div>
        </div>
      `;

      $('body').append(modalHtml);
    }

    /**
     * Bind modal event handlers
     * @private
     */
    bindModalEvents() {
      // Tab switching
      $(document).on('click.authui', SELECTORS.tabButtons, (event) => {
        const $tab = $(event.currentTarget);
        const tabName = $tab.data('tab');
        this.switchTab(tabName);
      });

      // Modal close
      $(document).on('click.authui', SELECTORS.modalClose, (event) => {
        event.preventDefault();
        this.hideAuthModal();
      });

      // Modal backdrop close
      $(document).on('click.authui', SELECTORS.modal, (event) => {
        if (event.target === event.currentTarget) {
          this.hideAuthModal();
        }
      });

      // Form submissions
      $(document).on('submit.authui', SELECTORS.signinForm + ' form', async (event) => {
        event.preventDefault();
        await this.handleSignIn(event.target);
      });

      $(document).on('submit.authui', SELECTORS.signupForm + ' form', async (event) => {
        event.preventDefault();
        await this.handleSignUp(event.target);
      });

    }

    /**
     * Switch between signin/signup tabs
     * @private
     * @param {string} tabName - Tab name to switch to
     */
    switchTab(tabName) {
      this.state.currentTab = tabName;

      // Update tab buttons
      $(SELECTORS.tabButtons)
        .removeClass(CSS_CLASSES.tabActive)
        .attr('aria-selected', 'false');
      
      $(`[data-tab="${tabName}"]`)
        .addClass(CSS_CLASSES.tabActive)
        .attr('aria-selected', 'true');

      // Update forms
      $(SELECTORS.forms)
        .removeClass(CSS_CLASSES.formActive)
        .attr('aria-hidden', 'true');
      
      $(`#auth-${tabName}-form`)
        .addClass(CSS_CLASSES.formActive)
        .attr('aria-hidden', 'false');

      // Clear messages and focus first input
      this.clearMessages();
      setTimeout(() => {
        const firstInput = $(`#auth-${tabName}-form input:first`);
        if (firstInput.length) {
          firstInput.focus();
        }
      }, 100);
    }

    /**
     * Handle sign in form submission
     * @private
     * @async
     * @param {HTMLFormElement} form - Sign in form element
     */
    async handleSignIn(form) {
      const formData = new FormData(form);
      const email = $('#signin-email').val().trim();
      const password = $('#signin-password').val();

      if (!this.validateSignInForm(email, password)) {
        return;
      }

      try {
        this.showMessage('Signing in...', 'info');
        await window.firebaseAuth.signIn(email, password);
        this.hideAuthModal();
      } catch (error) {
        console.error('Sign in error:', error);
        this.showMessage(error.message, 'error');
      }
    }

    /**
     * Handle sign up form submission
     * @private
     * @async
     * @param {HTMLFormElement} form - Sign up form element
     */
    async handleSignUp(form) {
      const email = $('#signup-email').val().trim();
      const password = $('#signup-password').val();

      if (!this.validateSignUpForm(email, password)) {
        return;
      }

      try {
        this.showMessage('Creating account...', 'info');
        await window.firebaseAuth.signUp(email, password);
        this.hideAuthModal();
      } catch (error) {
        console.error('Sign up error:', error);
        this.showMessage(error.message, 'error');
      }
    }


    /**
     * Validate sign in form
     * @private
     * @param {string} email - Email address
     * @param {string} password - Password
     * @returns {boolean} True if valid
     */
    validateSignInForm(email, password) {
      let isValid = true;

      // Clear previous errors
      $('.auth-form__input').removeClass(CSS_CLASSES.inputError);
      $('.auth-form__error').text('').hide();

      if (!email) {
        $('#signin-email').addClass(CSS_CLASSES.inputError);
        $('#signin-email-error').text('Email is required').show();
        isValid = false;
      } else if (!isValidEmail(email)) {
        $('#signin-email').addClass(CSS_CLASSES.inputError);
        $('#signin-email-error').text('Please enter a valid email address').show();
        isValid = false;
      }

      if (!password) {
        $('#signin-password').addClass(CSS_CLASSES.inputError);
        $('#signin-password-error').text('Password is required').show();
        isValid = false;
      }

      return isValid;
    }

    /**
     * Validate sign up form
     * @private
     * @param {string} email - Email address
     * @param {string} password - Password
     * @returns {boolean} True if valid
     */
    validateSignUpForm(email, password) {
      let isValid = true;

      // Clear previous errors
      $('.auth-form__input').removeClass(CSS_CLASSES.inputError);
      $('.auth-form__error').text('').hide();

      if (!email) {
        $('#signup-email').addClass(CSS_CLASSES.inputError);
        $('#signup-email-error').text('Email is required').show();
        isValid = false;
      } else if (!isValidEmail(email)) {
        $('#signup-email').addClass(CSS_CLASSES.inputError);
        $('#signup-email-error').text('Please enter a valid email address').show();
        isValid = false;
      }

      if (!password) {
        $('#signup-password').addClass(CSS_CLASSES.inputError);
        $('#signup-password-error').text('Password is required').show();
        isValid = false;
      } else if (password.length < 6) {
        $('#signup-password').addClass(CSS_CLASSES.inputError);
        $('#signup-password-error').text('Password must be at least 6 characters long').show();
        isValid = false;
      }

      return isValid;
    }

    /**
     * Show authentication modal
     * @private
     */
    showAuthModal() {
      if (!this.isAuthAvailable()) {
        alert('Firebase authentication is not configured yet. Please see setup-firebase.md for instructions.');
        return;
      }

      this.state.isModalOpen = true;
      $(SELECTORS.modal).addClass(CSS_CLASSES.modalVisible);
      $('body').addClass(CSS_CLASSES.modalOpen);

      setTimeout(() => {
        const firstInput = $(SELECTORS.modal).find('input:visible').first();
        if (firstInput.length) {
          firstInput.focus();
        }
      }, 100);
    }

    /**
     * Hide authentication modal
     * @private
     */
    hideAuthModal() {
      this.state.isModalOpen = false;
      $(SELECTORS.modal).removeClass(CSS_CLASSES.modalVisible);
      $('body').removeClass(CSS_CLASSES.modalOpen);
      
      this.clearMessages();
      this.clearForms();
      $('#auth-signin-btn').focus();
    }

    /**
     * Show message in modal
     * @private
     * @param {string} message - Message text
     * @param {string} type - Message type
     */
    showMessage(message, type = 'info') {
      const messageEl = $(SELECTORS.messageContainer);
      const safeMessage = escapeHtml(message);

      messageEl
        .removeClass('auth-message--success auth-message--error auth-message--info auth-message--warning')
        .addClass(`auth-message--${type} ${CSS_CLASSES.messageVisible}`)
        .text(safeMessage)
        .show();
    }

    /**
     * Clear all messages
     * @private
     */
    clearMessages() {
      $(SELECTORS.messageContainer)
        .removeClass(CSS_CLASSES.messageVisible)
        .hide()
        .text('');
    }

    /**
     * Clear all forms
     * @private
     */
    clearForms() {
      $(SELECTORS.signinForm + ' form')[0]?.reset();
      $(SELECTORS.signupForm + ' form')[0]?.reset();
    }

    /**
     * Check if Firebase Auth is available
     * @returns {boolean} True if available
     */
    isAuthAvailable() {
      return window.firebaseAuth && window.firebaseAuth.isAvailable();
    }
  }

  /* ==========================================================================
     Site-wide Main Functionality (from original main.js)
     ========================================================================== */

  // Site variables
  const $window = $(window);
  const $banner = $('#banner');
  const $body = $('body');

  // Breakpoints configuration
  breakpoints({
    default: ['1681px', null],
    xlarge: ['1281px', '1680px'],
    large: ['981px', '1280px'],
    medium: ['737px', '980px'],
    small: ['481px', '736px'],
    xsmall: ['361px', '480px'],
    xxsmall: [null, '360px']
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

  // Load Firebase config first
  FirebaseConfig.loadConfigScript();

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