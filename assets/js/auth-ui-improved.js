/**
 * Authentication UI Component
 * Handles Firebase authentication interface and user interactions
 * Follows ES6+ standards and accessibility guidelines
 * 
 * @class AuthUI
 */
class AuthUI {
  /**
   * Create an AuthUI instance
   */
  constructor() {
    // Constants
    this.SELECTORS = {
      authContainer: '[data-js="auth-container"]',
      menuToggle: '[data-js="menu-toggle"]',
      modal: '#auth-modal',
      modalClose: '.auth-modal__close',
      tabButtons: '.auth-tab',
      forms: '.auth-form',
      signinForm: '#auth-signin-form',
      signupForm: '#auth-signup-form',
      messageContainer: '#auth-message'
    };
    
    this.CSS_CLASSES = {
      modalOpen: 'auth-modal-open',
      modalVisible: 'auth-modal--visible',
      tabActive: 'auth-tab--active',
      formActive: 'auth-form--active',
      messageVisible: 'auth-message--visible'
    };
    
    // State management
    this.state = {
      isModalOpen: false,
      currentUser: null,
      headerLoaded: false,
      currentTab: 'signin'
    };
    
    // Cached DOM elements
    this.elements = {};
    
    this.init();
  }
  
  /**
   * Initialize the AuthUI component
   * @private
   */
  init() {
    this.setupEventListeners();
    this.waitForHeader();
    
    // Set up Firebase auth state listener when available
    if (window.firebaseAuth) {
      window.firebaseAuth.onAuthStateChange(user => this.handleAuthStateChange(user));
    }
  }
  
  /**
   * Set up global event listeners
   * @private
   */
  setupEventListeners() {
    // DOM ready handler
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
    // ESC key to close modal
    $(document).on('keydown', (event) => {
      if (event.key === 'Escape' && this.state.isModalOpen) {
        this.hideAuthModal();
      }
    });
    
    // Trap focus in modal when open
    $(document).on('keydown', (event) => {
      if (this.state.isModalOpen && event.key === 'Tab') {
        this.trapFocus(event);
      }
    });
  }
  
  /**
   * Trap focus within modal for accessibility
   * @private
   * @param {KeyboardEvent} event - The keyboard event
   */
  trapFocus(event) {
    const modal = document.querySelector(this.SELECTORS.modal);
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
   * Wait for header to be loaded by the include system
   * @private
   */
  waitForHeader() {
    const checkHeader = () => {
      const authContainer = $(this.SELECTORS.authContainer);
      if (authContainer.length > 0) {
        this.state.headerLoaded = true;
        this.cacheElements();
        this.updateHeaderUI();
        return;
      }
      
      // Retry after delay
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
      authContainer: $(this.SELECTORS.authContainer),
      menuToggle: $(this.SELECTORS.menuToggle)
    };
  }
  
  /**
   * Called by main.js when header is loaded
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
   * @param {Object|null} user - Firebase user object or null
   */
  handleAuthStateChange(user) {
    this.state.currentUser = user;
    
    if (this.state.headerLoaded) {
      this.updateHeaderUI();
    }
  }
  
  /**
   * Update the header authentication UI
   * @private
   */
  updateHeaderUI() {
    if (!this.elements.authContainer?.length || !this.state.headerLoaded) {
      return;
    }
    
    // Check if Firebase Auth is available
    if (!this.isAuthAvailable()) {
      this.renderSignInButton();
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
    const safeDisplayName = this.escapeHtml(displayName);
    
    this.elements.authContainer.html(`
      <div class="auth-user" role="group" aria-label="User account">
        <span class="auth-user__name" title="${safeDisplayName}">${safeDisplayName}</span>
        <button 
          id="auth-signout-btn" 
          class="auth-button auth-button--signout" 
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
      <div class="auth-signin-prompt">
        <button 
          id="auth-signin-btn" 
          class="auth-button" 
          type="button"
          aria-label="Sign in to your account"
        >
          Sign In
        </button>
      </div>
    `);
  }
  
  /**
   * Bind header-specific event handlers
   * @private
   */
  bindHeaderEvents() {
    // Remove existing handlers to prevent duplicates
    $('#auth-signin-btn').off('click.authui');
    $('#auth-signout-btn').off('click.authui');
    
    // Sign in button handler
    $('#auth-signin-btn').on('click.authui', (event) => {
      event.preventDefault();
      this.showAuthModal();
    });
    
    // Sign out button handler
    $('#auth-signout-btn').on('click.authui', async (event) => {
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
    try {
      await window.firebaseAuth.signOut();
      this.showMessage('Signed out successfully', 'success');
    } catch (error) {
      console.error('Sign out error:', error);
      this.showMessage('Error signing out. Please try again.', 'error');
    }
  }
  
  /**
   * Create the authentication modal
   * @private
   */
  createAuthModal() {
    const modalHtml = `
      <div id="auth-modal" class="auth-modal" role="dialog" aria-modal="true" aria-labelledby="auth-modal-title">
        <div class="auth-modal__content">
          <div class="auth-modal__header">
            <h2 id="auth-modal-title" class="auth-modal__title">Sign In to Sync Your Progress</h2>
            <button 
              class="auth-modal__close" 
              type="button"
              aria-label="Close authentication modal"
            >
              <span aria-hidden="true">&times;</span>
            </button>
          </div>
          
          <div class="auth-sync-message">
            <p class="auth-sync-message__text">
              <strong>Signing in is optional!</strong> Your progress is automatically saved in your browser. 
              Sign in only if you want to sync your progress across multiple devices.
            </p>
          </div>
          
          <div class="auth-tabs" role="tablist" aria-label="Authentication options">
            <button 
              class="auth-tab auth-tab--active" 
              data-tab="signin" 
              role="tab" 
              aria-selected="true" 
              aria-controls="auth-signin-form"
              id="signin-tab"
            >
              Sign In
            </button>
            <button 
              class="auth-tab" 
              data-tab="signup" 
              role="tab" 
              aria-selected="false" 
              aria-controls="auth-signup-form"
              id="signup-tab"
            >
              Sign Up
            </button>
          </div>
          
          <div class="auth-content">
            <div id="auth-signin-form" class="auth-form auth-form--active" role="tabpanel" aria-labelledby="signin-tab">
              <form novalidate>
                <div class="auth-form__field">
                  <label for="signin-email" class="sr-only">Email address</label>
                  <input 
                    type="email" 
                    id="signin-email" 
                    class="auth-form__input"
                    placeholder="Email" 
                    autocomplete="email" 
                    required
                    aria-describedby="signin-email-error"
                  >
                  <div id="signin-email-error" class="auth-form__error" role="alert"></div>
                </div>
                <div class="auth-form__field">
                  <label for="signin-password" class="sr-only">Password</label>
                  <input 
                    type="password" 
                    id="signin-password" 
                    class="auth-form__input"
                    placeholder="Password" 
                    autocomplete="current-password" 
                    required
                    aria-describedby="signin-password-error"
                  >
                  <div id="signin-password-error" class="auth-form__error" role="alert"></div>
                </div>
                <button type="submit" class="auth-button auth-button--primary">Sign In</button>
              </form>
              
              <div class="auth-divider">
                <span class="auth-divider__text">or</span>
              </div>
              
              <button id="google-signin-btn" class="auth-button auth-button--google" type="button">
                <span class="auth-button__google-icon" aria-hidden="true">G</span>
                Sign in with Google
              </button>
            </div>
            
            <div id="auth-signup-form" class="auth-form" role="tabpanel" aria-labelledby="signup-tab" aria-hidden="true">
              <form novalidate>
                <div class="auth-form__field">
                  <label for="signup-email" class="sr-only">Email address</label>
                  <input 
                    type="email" 
                    id="signup-email" 
                    class="auth-form__input"
                    placeholder="Email" 
                    autocomplete="email" 
                    required
                    aria-describedby="signup-email-error"
                  >
                  <div id="signup-email-error" class="auth-form__error" role="alert"></div>
                </div>
                <div class="auth-form__field">
                  <label for="signup-password" class="sr-only">Password (minimum 6 characters)</label>
                  <input 
                    type="password" 
                    id="signup-password" 
                    class="auth-form__input"
                    placeholder="Password (min 6 characters)" 
                    autocomplete="new-password" 
                    minlength="6"
                    required
                    aria-describedby="signup-password-error signup-password-help"
                  >
                  <div id="signup-password-help" class="auth-form__help">Password must be at least 6 characters long</div>
                  <div id="signup-password-error" class="auth-form__error" role="alert"></div>
                </div>
                <button type="submit" class="auth-button auth-button--primary">Create Account</button>
              </form>
              
              <div class="auth-divider">
                <span class="auth-divider__text">or</span>
              </div>
              
              <button id="google-signup-btn" class="auth-button auth-button--google" type="button">
                <span class="auth-button__google-icon" aria-hidden="true">G</span>
                Sign up with Google
              </button>
            </div>
          </div>
          
          <div id="auth-message" class="auth-message" role="alert" aria-live="polite"></div>
        </div>
      </div>
    `;
    
    $('body').append(modalHtml);
  }
  
  /**
   * Bind modal-specific event handlers
   * @private
   */
  bindModalEvents() {
    // Modal close events
    $(document).on('click', `${this.SELECTORS.modalClose}, ${this.SELECTORS.modal}`, (event) => {
      if (event.target === event.currentTarget) {
        this.hideAuthModal();
      }
    });
    
    // Tab switching
    $(document).on('click', this.SELECTORS.tabButtons, (event) => {
      const tab = $(event.target).data('tab');
      this.switchTab(tab);
    });
    
    // Form submissions
    $(document).on('submit', `${this.SELECTORS.signinForm} form`, async (event) => {
      event.preventDefault();
      await this.handleEmailSignIn();
    });
    
    $(document).on('submit', `${this.SELECTORS.signupForm} form`, async (event) => {
      event.preventDefault();
      await this.handleEmailSignUp();
    });
    
    // Google sign in buttons
    $(document).on('click', '#google-signin-btn, #google-signup-btn', async (event) => {
      event.preventDefault();
      await this.handleGoogleSignIn();
    });
  }
  
  /**
   * Switch between sign-in and sign-up tabs
   * @private
   * @param {string} tab - Tab identifier ('signin' or 'signup')
   */
  switchTab(tab) {
    this.state.currentTab = tab;
    
    // Update tab buttons
    $(this.SELECTORS.tabButtons)
      .removeClass(this.CSS_CLASSES.tabActive)
      .attr('aria-selected', 'false');
    
    $(this.SELECTORS.tabButtons)
      .filter(`[data-tab="${tab}"]`)
      .addClass(this.CSS_CLASSES.tabActive)
      .attr('aria-selected', 'true');
    
    // Update form visibility
    $(this.SELECTORS.forms)
      .removeClass(this.CSS_CLASSES.formActive)
      .attr('aria-hidden', 'true');
    
    $(`#auth-${tab}-form`)
      .addClass(this.CSS_CLASSES.formActive)
      .attr('aria-hidden', 'false');
    
    this.clearMessages();
  }
  
  /**
   * Show the authentication modal
   * @private
   */
  showAuthModal() {
    // Check if Firebase is configured
    if (!this.isAuthAvailable()) {
      this.showNotConfiguredAlert();
      return;
    }
    
    this.state.isModalOpen = true;
    
    // Show modal and add body class
    $(this.SELECTORS.modal).addClass(this.CSS_CLASSES.modalVisible);
    $('body').addClass(this.CSS_CLASSES.modalOpen);
    
    // Focus first input for accessibility
    setTimeout(() => {
      const firstInput = $(this.SELECTORS.modal).find('input:visible').first();
      if (firstInput.length) {
        firstInput.focus();
      }
    }, 100);
    
    // Update menu toggle ARIA state
    if (this.elements.menuToggle?.length) {
      this.elements.menuToggle.attr('aria-expanded', 'false');
    }
  }
  
  /**
   * Hide the authentication modal
   * @private
   */
  hideAuthModal() {
    this.state.isModalOpen = false;
    
    // Hide modal and remove body class
    $(this.SELECTORS.modal).removeClass(this.CSS_CLASSES.modalVisible);
    $('body').removeClass(this.CSS_CLASSES.modalOpen);
    
    this.clearMessages();
    this.clearForms();
    
    // Return focus to trigger element
    $('#auth-signin-btn').focus();
  }
  
  /**
   * Show alert when Firebase is not configured
   * @private
   */
  showNotConfiguredAlert() {
    const message = 'Firebase authentication is not configured yet. Please see setup-firebase.md for instructions.';
    
    // Use a more accessible notification method
    if ('Notification' in window && Notification.permission === 'granted') {
      new Notification('Authentication Not Available', { body: message });
    } else {
      alert(message);
    }
  }
  
  /**
   * Handle email sign-in form submission
   * @private
   * @async
   */
  async handleEmailSignIn() {
    const email = $('#signin-email').val().trim();
    const password = $('#signin-password').val();
    
    // Clear previous errors
    this.clearFieldErrors();
    
    // Validate inputs
    const validationErrors = this.validateSignInInputs(email, password);
    if (validationErrors.length > 0) {
      this.showValidationErrors(validationErrors);
      return;
    }
    
    try {
      this.showMessage('Signing in...', 'info');
      await window.firebaseAuth.signIn(email, password);
      this.showMessage('Signed in successfully!', 'success');
      
      setTimeout(() => this.hideAuthModal(), 1000);
    } catch (error) {
      console.error('Sign in error:', error);
      this.showMessage(error.message, 'error');
      
      // Focus the relevant field based on error
      if (error.message.includes('email')) {
        $('#signin-email').focus();
      } else if (error.message.includes('password')) {
        $('#signin-password').focus();
      }
    }
  }
  
  /**
   * Handle email sign-up form submission
   * @private
   * @async
   */
  async handleEmailSignUp() {
    const email = $('#signup-email').val().trim();
    const password = $('#signup-password').val();
    
    // Clear previous errors
    this.clearFieldErrors();
    
    // Validate inputs
    const validationErrors = this.validateSignUpInputs(email, password);
    if (validationErrors.length > 0) {
      this.showValidationErrors(validationErrors);
      return;
    }
    
    try {
      this.showMessage('Creating account...', 'info');
      await window.firebaseAuth.signUp(email, password);
      this.showMessage('Account created successfully!', 'success');
      
      setTimeout(() => this.hideAuthModal(), 1000);
    } catch (error) {
      console.error('Sign up error:', error);
      this.showMessage(error.message, 'error');
      
      // Focus the relevant field based on error
      if (error.message.includes('email')) {
        $('#signup-email').focus();
      }
    }
  }
  
  /**
   * Handle Google sign-in
   * @private
   * @async
   */
  async handleGoogleSignIn() {
    try {
      this.showMessage('Opening Google sign in...', 'info');
      await window.firebaseAuth.signInWithGoogle();
      this.showMessage('Signed in with Google!', 'success');
      
      setTimeout(() => this.hideAuthModal(), 1000);
    } catch (error) {
      console.error('Google sign in error:', error);
      
      if (error.message.includes('popup')) {
        this.showMessage('Sign-in popup was closed. Please try again.', 'error');
      } else {
        this.showMessage(error.message, 'error');
      }
    }
  }
  
  /**
   * Validate sign-in form inputs
   * @private
   * @param {string} email - Email address
   * @param {string} password - Password
   * @returns {Array} Array of validation errors
   */
  validateSignInInputs(email, password) {
    const errors = [];
    
    if (!email) {
      errors.push({ field: 'signin-email', message: 'Email is required' });
    } else if (!this.isValidEmail(email)) {
      errors.push({ field: 'signin-email', message: 'Please enter a valid email address' });
    }
    
    if (!password) {
      errors.push({ field: 'signin-password', message: 'Password is required' });
    }
    
    return errors;
  }
  
  /**
   * Validate sign-up form inputs
   * @private
   * @param {string} email - Email address
   * @param {string} password - Password
   * @returns {Array} Array of validation errors
   */
  validateSignUpInputs(email, password) {
    const errors = [];
    
    if (!email) {
      errors.push({ field: 'signup-email', message: 'Email is required' });
    } else if (!this.isValidEmail(email)) {
      errors.push({ field: 'signup-email', message: 'Please enter a valid email address' });
    }
    
    if (!password) {
      errors.push({ field: 'signup-password', message: 'Password is required' });
    } else if (password.length < 6) {
      errors.push({ field: 'signup-password', message: 'Password must be at least 6 characters long' });
    }
    
    return errors;
  }
  
  /**
   * Validate email address format
   * @private
   * @param {string} email - Email address to validate
   * @returns {boolean} True if valid
   */
  isValidEmail(email) {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(email);
  }
  
  /**
   * Show validation errors
   * @private
   * @param {Array} errors - Array of validation errors
   */
  showValidationErrors(errors) {
    errors.forEach(error => {
      const errorElement = $(`#${error.field}-error`);
      if (errorElement.length) {
        errorElement.text(error.message).show();
      }
      
      // Add error styling to field
      $(`#${error.field}`).addClass('auth-form__input--error');
    });
    
    // Focus first error field
    if (errors.length > 0) {
      $(`#${errors[0].field}`).focus();
    }
  }
  
  /**
   * Clear field validation errors
   * @private
   */
  clearFieldErrors() {
    $('.auth-form__error').text('').hide();
    $('.auth-form__input').removeClass('auth-form__input--error');
  }
  
  /**
   * Show message in modal
   * @private
   * @param {string} message - Message text
   * @param {string} type - Message type ('info', 'success', 'error', 'warning')
   */
  showMessage(message, type = 'info') {
    const messageEl = $(this.SELECTORS.messageContainer);
    const safeMessage = this.escapeHtml(message);
    
    messageEl
      .removeClass('auth-message--success auth-message--error auth-message--info auth-message--warning')
      .addClass(`auth-message--${type} ${this.CSS_CLASSES.messageVisible}`)
      .text(safeMessage)
      .show();
    
    // Announce to screen readers
    messageEl.attr('aria-live', 'polite');
  }
  
  /**
   * Clear all messages
   * @private
   */
  clearMessages() {
    $(this.SELECTORS.messageContainer)
      .removeClass(this.CSS_CLASSES.messageVisible)
      .hide()
      .text('');
  }
  
  /**
   * Clear all form inputs
   * @private
   */
  clearForms() {
    $(`${this.SELECTORS.signinForm} form`)[0]?.reset();
    $(`${this.SELECTORS.signupForm} form`)[0]?.reset();
    this.clearFieldErrors();
  }
}

/**
 * Utility function to escape HTML entities
 * @param {string} text - Text to escape
 * @returns {string} Escaped text
 */
AuthUI.prototype.escapeHtml = function(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
};

/**
 * Check if Firebase Auth is available
 * @returns {boolean} True if available
 */
AuthUI.prototype.isAuthAvailable = function() {
  return window.firebaseAuth && window.firebaseAuth.isAvailable();
};

// Initialize Auth UI when ready
document.addEventListener('DOMContentLoaded', () => {
  window.authUI = new AuthUI();
  
  // Also trigger a manual check after delay for header loading
  setTimeout(() => {
    if (window.authUI && document.querySelector('[data-js="auth-container"]') && !window.authUI.state.headerLoaded) {
      window.authUI.onHeaderLoaded();
    }
  }, 1000);
});