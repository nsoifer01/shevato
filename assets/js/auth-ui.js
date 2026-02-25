/**
 * Authentication UI Class
 * Handles auth modal, sign in/up forms, header UI, and sign out confirmation.
 *
 * Dependencies: jQuery (global $), FirebaseAuth (window.firebaseAuth)
 */

const $ = window.jQuery;

export const SELECTORS = {
  authContainer: '[data-js="auth-container"]',
  menuToggle: '[data-js="menu-toggle"]',
  modal: '#auth-modal',
  modalClose: '.auth-modal__close',
  tabButtons: '.auth-tab',
  forms: '.auth-form',
  signinForm: '#auth-signin-form',
  signupForm: '#auth-signup-form',
  messageContainer: '#auth-message',
  skipLink: '.skip-link',
};

const CSS_CLASSES = {
  modalOpen: 'auth-modal-open',
  modalVisible: 'auth-modal--visible',
  tabActive: 'auth-tab--active',
  formActive: 'auth-form--active',
  messageVisible: 'auth-message--visible',
  inputError: 'auth-form__input--error',
};

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

export class AuthUI {
  constructor() {
    this.state = {
      isModalOpen: false,
      currentUser: null,
      headerLoaded: false,
      currentTab: 'signin',
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
      window.firebaseAuth.onAuthStateChange((user) => this.handleAuthStateChange(user));
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
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
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
      menuToggle: $(SELECTORS.menuToggle),
    };
  }

  /**
   * Called when header is loaded
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
      this.updateHeaderEmail(null);
      this.bindHeaderEvents();
      return;
    }

    if (this.state.currentUser) {
      this.renderUserInfo();
      this.updateHeaderEmail(this.state.currentUser);
    } else {
      this.renderSignInButton();
      this.updateHeaderEmail(null);
    }

    this.bindHeaderEvents();
  }

  /**
   * Update header email display
   * @private
   * @param {Object|null} user - Firebase user object
   */
  updateHeaderEmail(user) {
    const emailContainer = document.getElementById('user-email-header');
    const emailSpan = document.getElementById('header-user-email');

    if (!emailContainer || !emailSpan) {
      return;
    }

    if (user && user.email) {
      emailSpan.textContent = user.email;
      emailContainer.classList.add('signed-in');
    } else {
      emailSpan.textContent = '';
      emailContainer.classList.remove('signed-in');
    }
  }

  /**
   * Render signed-in user information
   * @private
   */
  renderUserInfo() {
    const displayName = this.state.currentUser.displayName || this.state.currentUser.email;
    const safeDisplayName = escapeHtml(displayName);

    this.elements.authContainer.html(`
      <div class="auth__user" role="group">
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
    $('#auth-signin-btn')
      .off('click.authui')
      .on('click.authui', (event) => {
        event.preventDefault();
        this.showAuthModal();
      });

    $('#auth-signout-btn')
      .off('click.authui')
      .on('click.authui', async (event) => {
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
    $(SELECTORS.tabButtons).removeClass(CSS_CLASSES.tabActive).attr('aria-selected', 'false');

    $(`[data-tab="${tabName}"]`).addClass(CSS_CLASSES.tabActive).attr('aria-selected', 'true');

    // Update forms
    $(SELECTORS.forms).removeClass(CSS_CLASSES.formActive).attr('aria-hidden', 'true');

    $(`#auth-${tabName}-form`).addClass(CSS_CLASSES.formActive).attr('aria-hidden', 'false');

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
  async handleSignIn(_form) {
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
  async handleSignUp(_form) {
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
      alert(
        'Firebase authentication is not configured yet. Please see setup-firebase.md for instructions.',
      );
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
      .removeClass(
        'auth-message--success auth-message--error auth-message--info auth-message--warning',
      )
      .addClass(`auth-message--${type} ${CSS_CLASSES.messageVisible}`)
      .text(safeMessage)
      .show();
  }

  /**
   * Clear all messages
   * @private
   */
  clearMessages() {
    $(SELECTORS.messageContainer).removeClass(CSS_CLASSES.messageVisible).hide().text('');
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
