/**
 * Global Enhanced JavaScript
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
    inputError: 'auth-form__input--error',
    errorVisible: 'auth-form__error--visible'
  };

  // Firebase config will be loaded from external file (firebase-config-local.js)
  // or from environment variables in production

  // Account deletion lives in the sync layer, next to the one list of app
  // namespaces. Resolve its URL against THIS script's src, captured while the
  // script is still evaluating: dynamic import() inside a classic script
  // resolves against the document's base URL, so an app page two directories
  // down would otherwise look for /apps/<app>/sync-system/. Same approach as
  // apps/maptap-rivals/js/app.js.
  const ACCOUNT_MODULE_URL = (function() {
    const src = document.currentScript && document.currentScript.src;
    return new URL('../../sync-system/app-sync-init.js', src || document.baseURI).href;
  })();

  /* ==========================================================================
     Utility Functions
     ========================================================================== */

  /**
   * Escape HTML entities to prevent XSS
   * @param {string} text - Text to escape
   * @returns {string} Escaped text
   */
// Escape for HTML, INCLUDING both quote characters.
//
// The `div.textContent -> div.innerHTML` trick escapes &, < and > and leaves
// " and ' alone, because a text node does not need them escaped. That is only
// safe while every interpolation lands in element CONTENT. It does not here:
// the shared chrome must not carry a weaker escaper than the app scripts it
// sits above, so a value carrying a double quote closes
// the attribute and the rest of the string becomes markup of the author's
// choosing. Escape all five, like the shared assets/js/escape-html.js.
  function escapeHtml(text) {
    return String(text == null ? '' : text).replace(/[&<>"']/g, (ch) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[ch]));
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

  /* ==========================================================================
     Firebase Authentication
     ==========================================================================
     `window.firebaseAuth` is provided by firebase-config.js (loaded as a
     module on every page). It exposes the surface this file used to
     duplicate via a compat-SDK class. We removed that class — and the
     compat SDK script tags — because loading both the v9 compat SDK
     and the v10 modular SDK created two separate auth iframes that
     raced over `apis.google.com/js/api.js?onload=__iframefcb<id>` and
     produced `Uncaught TypeError: u[v] is not a function` on mobile.
     Single SDK now: the modular one. */

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
      this._wireAuthListener();
    }

    /**
     * `window.firebaseAuth` is set by firebase-config.js, which loads
     * as `<script type="module">` and is therefore deferred until after
     * this regular script runs. Either it's already there (page was
     * cached / module finished early) or we wait for the
     * `firebaseAuthReady` event the module dispatches once it's set up.
     * @private
     */
    _wireAuthListener() {
      const wire = () => {
        if (!window.firebaseAuth) return false;
        window.firebaseAuth.onAuthStateChange(user => this.handleAuthStateChange(user));
        return true;
      };
      if (wire()) return;
      window.addEventListener('firebaseAuthReady', wire, { once: true });
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

      // Only VISIBLE focusables can be trap boundaries. The modal always
      // contains BOTH the signin and signup forms with one display:none'd;
      // a hidden element can never hold focus, so using it as first/last
      // meant the wrap condition never matched and Tab escaped the dialog.
      // Recomputed on every Tab because the visible set changes when the
      // user switches between the Sign In and Sign Up tabs.
      const focusableElements = Array.prototype.filter.call(
        modal.querySelectorAll(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
        ),
        (el) => !el.disabled
          && (el.offsetParent !== null || el.getClientRects().length > 0)
      );
      if (focusableElements.length === 0) return;
      const firstElement = focusableElements[0];
      const lastElement = focusableElements[focusableElements.length - 1];
      const active = document.activeElement;
      // If focus already leaked outside the dialog, pull it back in.
      const outside = !modal.contains(active);

      if (event.shiftKey && (active === firstElement || outside)) {
        event.preventDefault();
        lastElement.focus();
      } else if (!event.shiftKey && (active === lastElement || outside)) {
        event.preventDefault();
        firstElement.focus();
      }
    }

    /**
     * Wait for header to be loaded
     * @private
     */
    waitForHeader() {
      // Bounded: pages without the header partial (moadon-alef) never grow
      // an auth container, and an unbounded 100 ms poll ran for the life of
      // the page. onHeaderLoaded() from the include callback still covers a
      // header that lands after the cap.
      let attempts = 0;
      const MAX_ATTEMPTS = 100;
      const checkHeader = () => {
        const authContainer = $(SELECTORS.authContainer);
        if (authContainer.length > 0) {
          this.state.headerLoaded = true;
          this.cacheElements();
          this.updateHeaderUI();
          return;
        }
        if (++attempts >= MAX_ATTEMPTS || !document.querySelector('[data-include="header"]')) return;
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

            <div class="signout-modal__danger">
              <button class="signout-modal__delete-link" type="button">Delete account and all data</button>
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

      $('.signout-modal__delete-link').on('click', () => {
        this.hideSignOutConfirmation();
        this.showDeleteAccountModal();
      });

      // Keyboard handler
      $(document).on('keydown.signout', (event) => {
        if (event.key === 'Escape') {
          this.hideSignOutConfirmation();
          $(document).off('keydown.signout');
        }
      });
    }

    /* ----------------------------------------------------------------------
       Account deletion
       ----------------------------------------------------------------------
       Reached from the sign-out dialog, which is where the account controls
       already live. The gate is deliberately awkward: the current password
       (which also reauthenticates, so a stale session cannot fail half way
       through) plus the word DELETE typed by hand. The module enforces both
       again, so nothing here is the only thing standing between a stray click
       and the data.
       ---------------------------------------------------------------------- */

    /**
     * Show the delete-account confirmation modal
     * @private
     */
    showDeleteAccountModal() {
      const user = this.state.currentUser;
      if (!user || user.isAnonymous) {
        return;
      }

      this.createDeleteAccountModal(user);
      $('.delete-account-modal').addClass('delete-account-modal--visible');
      $('body').addClass('signout-modal-open');

      setTimeout(() => {
        $('#delete-account-password').focus();
      }, 100);
    }

    /**
     * Hide the delete-account confirmation modal
     * @private
     */
    hideDeleteAccountModal() {
      $('.delete-account-modal').removeClass('delete-account-modal--visible');
      $('body').removeClass('signout-modal-open');
      $(document).off('keydown.deleteaccount');

      setTimeout(() => {
        $('.delete-account-modal').remove();
      }, 300);
    }

    /**
     * Build the delete-account confirmation modal.
     *
     * The "kept" list is not padding. Arena's leaderboard row, head-to-head
     * records and Globe Drop daily scores sit outside users/{uid} and the
     * security rules do not let their owner delete them, and room chat is
     * append-only by design. Saying so up front is the difference between an
     * honest control and one that overclaims.
     * @private
     * @param {Object} user - Signed-in Firebase user
     */
    createDeleteAccountModal(user) {
      $('.delete-account-modal').remove();

      const safeEmail = escapeHtml(user.email || '');

      const modalHtml = `
        <div class="delete-account-modal" role="dialog" aria-modal="true" aria-labelledby="delete-account-title">
          <div class="delete-account-modal__content">
            <div class="delete-account-modal__header">
              <div class="delete-account-modal__icon">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <path d="M12 9V13M12 17H12.01M10.29 3.86L1.82 18C1.64 18.32 1.55 18.68 1.55 19.05C1.55 19.42 1.65 19.78 1.83 20.09C2.02 20.41 2.28 20.67 2.6 20.85C2.92 21.03 3.28 21.12 3.65 21.12H20.35C20.72 21.12 21.08 21.03 21.4 20.85C21.72 20.67 21.98 20.41 22.17 20.09C22.35 19.78 22.45 19.42 22.45 19.05C22.45 18.68 22.36 18.32 22.18 18L13.71 3.86C13.53 3.55 13.27 3.29 12.96 3.11C12.65 2.93 12.29 2.83 11.93 2.83C11.57 2.83 11.22 2.93 10.9 3.11C10.59 3.29 10.34 3.55 10.16 3.86H10.29Z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                </svg>
              </div>
              <h2 id="delete-account-title" class="delete-account-modal__title">Delete Account</h2>
            </div>

            <div class="delete-account-modal__body">
              <p class="delete-account-modal__message">
                This permanently deletes <strong>${safeEmail}</strong> and the data it stores. It cannot be undone.
              </p>

              <p class="delete-account-modal__label">This removes</p>
              <ul class="delete-account-modal__list">
                <li>Your synced data for every app, in the cloud and on this device</li>
                <li>Your Arena profile, including XP, wins and games played</li>
                <li>Your MapTap Rivals network entry and the links to connected rivals</li>
                <li>Your sign-in email and password</li>
              </ul>

              <p class="delete-account-modal__label">This does not remove</p>
              <ul class="delete-account-modal__list delete-account-modal__list--kept">
                <li>Your Arena leaderboard row, head-to-head records and Globe Drop daily scores. Only leaderboard admins can remove those.</li>
                <li>Anything you posted in Arena room chat. Chat is permanent by design.</li>
              </ul>

              <p class="delete-account-modal__note">
                Other devices that are signed in keep their own local copy until it is cleared there.
              </p>

              <div class="delete-account-modal__field">
                <label for="delete-account-password">Your password</label>
                <input type="password" id="delete-account-password" autocomplete="current-password" placeholder="Password">
              </div>

              <div class="delete-account-modal__field">
                <label for="delete-account-confirm">Type DELETE to confirm</label>
                <input type="text" id="delete-account-confirm" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="DELETE">
              </div>

              <div class="delete-account-modal__status" role="alert" aria-live="polite"></div>
            </div>

            <div class="delete-account-modal__actions">
              <button class="delete-account-confirm-btn" type="button" disabled>Delete account</button>
              <button class="delete-account-cancel-btn" type="button">Cancel</button>
            </div>
          </div>
        </div>
      `;

      $('body').append(modalHtml);

      $('.delete-account-cancel-btn, .delete-account-modal').on('click', (event) => {
        if (event.target === event.currentTarget) {
          this.hideDeleteAccountModal();
        }
      });

      $('#delete-account-confirm').on('input', () => {
        const typed = $('#delete-account-confirm').val() || '';
        $('.delete-account-confirm-btn').prop('disabled', typed.trim() !== 'DELETE');
      });

      $('.delete-account-confirm-btn').on('click', () => {
        this.performAccountDeletion();
      });

      $(document).on('keydown.deleteaccount', (event) => {
        if (event.key === 'Escape') {
          this.hideDeleteAccountModal();
        }
      });
    }

    /**
     * Run the deletion and report exactly what happened.
     * @private
     * @async
     */
    async performAccountDeletion() {
      const $confirm = $('.delete-account-confirm-btn');
      const originalLabel = $confirm.text();

      $confirm.prop('disabled', true).text('Deleting...');
      $('.delete-account-cancel-btn').prop('disabled', true);
      this.showDeleteStatus('Deleting your account. Do not close this tab.', 'info');

      let result;
      try {
        const module = await import(ACCOUNT_MODULE_URL);
        result = await module.deleteAccount({
          confirmation: $('#delete-account-confirm').val(),
          password: $('#delete-account-password').val()
        });
      } catch (error) {
        console.error('Account deletion error:', error);
        result = {
          ok: false,
          message: 'Something went wrong and the account was not deleted. Check your connection and try again.'
        };
      }

      if (result.ok) {
        this.showDeleteStatus('Your account and its data have been deleted.', 'success');
        $('.delete-account-cancel-btn').remove();
        // Reload rather than leaving the page up: apps hold their state in
        // memory and would write it straight back to the localStorage keys we
        // just cleared on the next interaction.
        setTimeout(() => { window.location.reload(); }, 2500);
        return;
      }

      this.showDeleteStatus(result.message, 'error');
      $confirm.prop('disabled', false).text(originalLabel);
      $('.delete-account-cancel-btn').prop('disabled', false);
    }

    /**
     * Show a status message inside the delete-account modal
     * @private
     * @param {string} message - Message text
     * @param {string} type - Message type
     */
    showDeleteStatus(message, type) {
      $('.delete-account-modal__status')
        .removeClass('delete-account-modal__status--info delete-account-modal__status--error delete-account-modal__status--success')
        .addClass(`delete-account-modal__status--${type} delete-account-modal__status--visible`)
        .text(message);
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
                  <button type="button" class="auth-form__forgot" data-js="forgot-password">Forgot password?</button>
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

      // Forgot password
      $(document).on('click.authui', '[data-js="forgot-password"]', async (event) => {
        event.preventDefault();
        await this.handleForgotPassword();
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
      const email = $('#signin-email').val().trim();
      const password = $('#signin-password').val();

      if (!this.validateSignInForm(email, password)) {
        return;
      }
      if (this.state.busy) return;

      try {
        this.setBusy(form, true);
        this.showMessage('Signing in...', 'info');
        await window.firebaseAuth.signIn(email, password);
        this.hideAuthModal();
      } catch (error) {
        console.error('Sign in error:', error);
        this.showMessage(this.userMessage(error), 'error');
      } finally {
        this.setBusy(form, false);
      }
    }

    /**
     * Disable the form's submit control while a request is in flight so a
     * double click cannot fire two sign-in attempts. Mirrored on the modal
     * state so the other handlers can refuse to start a second request.
     * @private
     */
    setBusy(form, busy) {
      this.state.busy = !!busy;
      const $btn = $(form).find('button[type="submit"]');
      $btn.prop('disabled', !!busy).attr('aria-busy', busy ? 'true' : null);
    }

    /**
     * Only messages firebase-config.js already humanised (or our own copy)
     * reach the banner. Anything that still looks like an SDK string, or has
     * no message, falls back to generic copy.
     * @private
     */
    userMessage(error) {
      const text = error && typeof error.message === 'string' ? error.message.trim() : '';
      if (!text || /^firebase\b|\(auth\//i.test(text)) {
        return 'Something went wrong. Please try again in a moment.';
      }
      return text;
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
      if (this.state.busy) return;

      try {
        this.setBusy(form, true);
        this.showMessage('Creating account...', 'info');
        await window.firebaseAuth.signUp(email, password);
        this.hideAuthModal();
      } catch (error) {
        console.error('Sign up error:', error);
        this.showMessage(this.userMessage(error), 'error');
      } finally {
        this.setBusy(form, false);
      }
    }


    /**
     * Handle "Forgot password?" click. Reads the email already typed into the
     * sign-in form and asks Firebase to send a reset link. The confirmation is
     * deliberately the same whether or not the address is registered, so the
     * modal cannot be used to probe which emails exist.
     * @private
     * @async
     */
    async handleForgotPassword() {
      const email = $('#signin-email').val().trim();
      this.clearAuthFormErrors();
      // A banner left by a failed sign-in must not sit next to a fresh field
      // error or a reset confirmation.
      this.clearMessages();

      if (!email) {
        this.showFieldError('#signin-email', '#signin-email-error', 'Enter your email above first, then tap Forgot password.');
        return;
      }
      if (!isValidEmail(email)) {
        this.showFieldError('#signin-email', '#signin-email-error', 'Please enter a valid email address');
        return;
      }

      try {
        this.showMessage('Sending reset link...', 'info');
        await window.firebaseAuth.resetPassword(email);
        this.showMessage('If that address has an account, a reset link is on its way. Check your email.', 'success');
      } catch (error) {
        console.error('Password reset error:', error);
        this.showMessage(this.userMessage(error), 'error');
      }
    }

    /**
     * Clear inline error state from all auth form inputs.
     * The CSS forces `.auth-form__error { display: none !important }`, so
     * visibility is driven by the `auth-form__error--visible` class — not
     * jQuery `.show()` / `.hide()`, which can't beat `!important`.
     * @private
     */
    clearAuthFormErrors() {
      $('.auth-form__input').removeClass(CSS_CLASSES.inputError);
      $('.auth-form__error').text('').removeClass(CSS_CLASSES.errorVisible);
    }

    /**
     * Mark a field as invalid: add error class to the input and reveal the
     * matching error message element.
     * @private
     */
    showFieldError(inputSelector, errorSelector, message) {
      $(inputSelector).addClass(CSS_CLASSES.inputError);
      $(errorSelector).text(message).addClass(CSS_CLASSES.errorVisible);
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
      this.clearAuthFormErrors();

      if (!email) {
        this.showFieldError('#signin-email', '#signin-email-error', 'Email is required');
        isValid = false;
      } else if (!isValidEmail(email)) {
        this.showFieldError('#signin-email', '#signin-email-error', 'Please enter a valid email address');
        isValid = false;
      }

      if (!password) {
        this.showFieldError('#signin-password', '#signin-password-error', 'Password is required');
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
      this.clearAuthFormErrors();

      if (!email) {
        this.showFieldError('#signup-email', '#signup-email-error', 'Email is required');
        isValid = false;
      } else if (!isValidEmail(email)) {
        this.showFieldError('#signup-email', '#signup-email-error', 'Please enter a valid email address');
        isValid = false;
      }

      if (!password) {
        this.showFieldError('#signup-password', '#signup-password-error', 'Password is required');
        isValid = false;
      } else if (password.length < 6) {
        this.showFieldError('#signup-password', '#signup-password-error', 'Password must be at least 6 characters long');
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
        // Misconfiguration is a developer-facing problem, not a user-facing
        // one. The Sign In button is hidden via updateHeaderUI when auth
        // isn't initialized, so this branch should only fire when something
        // unusual has gone wrong — log instead of blocking the page.
        console.warn('Firebase authentication is not configured; cannot open sign-in modal.');
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
      // Field errors and the selected tab used to survive close/reopen: the
      // modal came back on Sign Up with a stale "valid email" error under an
      // empty field. Reopen always starts on a clean Sign In tab.
      this.clearAuthFormErrors();
      if (this.state.currentTab !== 'signin') this.switchTab('signin');
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
    const $menu = $('#menu');
    const $menuToggle = $(SELECTORS.menuToggle);
    
    $menu
      // aria-label, because this link has no text content: it is an icon drawn
      // in CSS. Without a name a screen reader announces it only as "link", so
      // the sole way out of the open mobile menu was unlabelled.
      .append('<a href="#menu" class="close" aria-label="Close menu"></a>')
      .appendTo($body)
      .panel({
        target: $body,
        visibleClass: 'is-menu-visible',
        delay: 500,
        hideOnClick: true,
        // Escape must close the open menu (WCAG 2.1 dismissible); util.js
        // only binds the keydown handler when this flag is set.
        hideOnEscape: true,
        hideOnSwipe: true,
        resetScroll: true,
        resetForms: true,
        side: 'right'
      });
    
    // The open panel behaves as a modal overlay: main.css locks body scroll
    // while `is-menu-visible` is set, and the handlers below keep keyboard
    // focus inside it (WCAG 2.4.3 focus order) and hand it back to the
    // toggle on close. Before this, Tab walked the page hidden behind the
    // overlay and the document scrolled underneath it.
    const focusables = () => $menu.find('a[href], button:not([disabled])').toArray();
    let menuOpen = false;
    let lockedScrollY = null;

    const handleMenuVisibility = () => {
      const isVisible = $body.hasClass('is-menu-visible');

      // Update aria attributes
      $menuToggle.attr('aria-expanded', isVisible);
      $menu.attr('aria-hidden', !isVisible);

      if (isVisible === menuOpen) return; // class changed for another reason
      menuOpen = isVisible;

      // Scroll lock. `body.is-menu-visible { overflow: hidden }` in main.css
      // is NOT enough on its own: with the panel open the document still
      // scrolled behind it (measured 0 -> 300 while body overflow computed
      // to hidden), which is what "mobile: open menu locks page scroll" in
      // tests/browser/suites/site.mjs catches. Pinning the body at its
      // current offset is what actually holds, so the offset has to be
      // restored on close or the page jumps to the top.
      if (isVisible) {
        lockedScrollY = window.scrollY || window.pageYOffset || 0;
        $body.css({ position: 'fixed', top: -lockedScrollY + 'px', left: 0, right: 0, width: '100%' });
      } else if (lockedScrollY !== null) {
        $body.css({ position: '', top: '', left: '', right: '', width: '' });
        window.scrollTo(0, lockedScrollY);
        lockedScrollY = null;
      }

      if (isVisible) {
        // #menu transitions `visibility` (main.css), so at this instant its
        // links are still visibility:hidden and refuse focus. Wait one frame
        // for the transition to start, then move focus in.
        window.setTimeout(() => {
          if (!$body.hasClass('is-menu-visible')) return;
          const first = focusables()[0];
          if (first && !$menu[0].contains(document.activeElement)) first.focus();
        }, 60);
      } else {
        // Return focus to the control that opens the menu so keyboard users
        // do not land on <body> after Escape, the close control or a tap
        // outside the panel.
        if ($menu[0].contains(document.activeElement) || document.activeElement === document.body) {
          $menuToggle.trigger('focus');
        }
      }
      wasOpen = isVisible;
    };

    // Trap Tab / Shift+Tab inside the open panel, wrapping at both ends.
    $menu.on('keydown', (event) => {
      if (event.key !== 'Tab' || !$body.hasClass('is-menu-visible')) return;
      const items = focusables();
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    });
    
    // Watch for visibility changes
    const observer = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        if (mutation.attributeName === 'class') {
          handleMenuVisibility();
        }
      });
    });
    
    observer.observe($body[0], {
      attributes: true,
      attributeFilter: ['class']
    });
    
    // Initial state
    handleMenuVisibility();
  }

  /**
   * Initialize the desktop "Apps" dropdown in the inline header nav.
   *
   * Mouse / keyboard: the toggle navigates to /apps.html (anchor default);
   * the menu opens on hover (CSS) and on keyboard focus (CSS :focus-within).
   * Touch (no hover): the first tap opens the menu (preventDefault); a second
   * tap while open navigates. Closes on mouse-leave (CSS), click outside, and
   * Escape (which hides the menu and returns focus to the toggle). Runs after
   * the header partial is injected.
   */
  function initializeAppsDropdown() {
    const $wrap = $('[data-js="nav-apps"]');
    const $toggle = $('[data-js="nav-apps-toggle"]');
    if (!$wrap.length || !$toggle.length) {
      return;
    }

    const close = () => {
      $wrap.removeClass('is-open');
      $toggle.attr('aria-expanded', 'false');
    };
    const open = () => {
      $wrap.removeClass('is-dismissed').addClass('is-open');
      $toggle.attr('aria-expanded', 'true');
    };

    // Track the pointer type of the gesture that produced the next click so we
    // can tell a touch tap from a mouse click. Falls back to the hover media
    // query when PointerEvent is unavailable.
    let lastPointerType = '';
    if (window.PointerEvent) {
      $toggle.on('pointerdown.navApps', (event) => {
        lastPointerType = event.originalEvent.pointerType || '';
      });
    }
    const hoverNone = window.matchMedia && window.matchMedia('(hover: none)').matches;
    const isTouch = () => lastPointerType === 'touch' || lastPointerType === 'pen' ||
      (!lastPointerType && hoverNone);

    // Touch: first tap opens the menu, second tap navigates. Mouse/keyboard:
    // let the anchor navigate to /apps.html.
    $toggle.on('click.navApps', (event) => {
      if (isTouch() && !$wrap.hasClass('is-open')) {
        event.preventDefault();
        open();
      }
      lastPointerType = '';
    });

    // Keep aria-expanded in sync with hover-driven opens.
    $wrap.on('mouseenter.navApps', open).on('mouseleave.navApps', () => {
      $wrap.removeClass('is-dismissed');
      close();
    });

    // Keep aria-expanded in sync with keyboard focus (CSS :focus-within opens
    // the menu). Entering a menu item also clears an Escape dismissal so Tab
    // can re-enter the menu after Escape.
    $wrap.on('focusin.navApps', (event) => {
      if (event.target !== $toggle[0]) {
        $wrap.removeClass('is-dismissed');
      }
      open();
    });
    $wrap.on('focusout.navApps', (event) => {
      if (!$wrap[0].contains(event.relatedTarget)) {
        $wrap.removeClass('is-dismissed');
        close();
      }
    });

    // Click outside closes.
    $(document).on('click.navApps', (event) => {
      if (!$wrap[0].contains(event.target)) {
        close();
      }
    });

    // Escape hides the menu and returns focus to the toggle. Because the toggle
    // is inside .nav-apps, :focus-within would keep the menu open; .is-dismissed
    // forces it hidden until focus leaves the wrapper or enters a menu item.
    // Focus the toggle first so that the resulting focusin fires (and open()
    // runs) before we set is-dismissed and call close(); this ensures the
    // final state is is-dismissed=true, is-open=false, aria-expanded=false.
    $(document).on('keydown.navApps', (event) => {
      if (event.key === 'Escape' && ($wrap.hasClass('is-open') || $wrap[0].contains(document.activeElement))) {
        $toggle.focus();
        $wrap.addClass('is-dismissed');
        close();
      }
    });
  }

  /* ==========================================================================
     Global Initialization
     ========================================================================== */

  // Initialize all components when DOM is ready
  $(document).ready(() => {
    // window.firebaseAuth is provided by firebase-config.js (loaded as
    // a deferred module). AuthUI waits on the `firebaseAuthReady`
    // event when the adapter isn't on window yet at construction time.
    window.authUI = new AuthUI();

    // Handle includes system
    const includes = $('[data-include]');

    jQuery.each(includes, function() {
      const includeFile = $(this).data('include') + '.html';
      const file = '/partials/' + includeFile;
      const $element = $(this);

      $element.load(file, function() {
        // Initialize menu after header is loaded
        if (includeFile === 'header.html' && $('#menu').length > 0) {
          initializeMenu();
        }

        // Initialize the desktop Apps dropdown after header is loaded
        if (includeFile === 'header.html') {
          initializeAppsDropdown();
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

          // Active page highlight + aria-current (header inline nav + #menu).
          // Skipped inside an app (/apps/<name>/): none of the five nav
          // targets is the current page there, so nothing gets marked.
          const path = window.location.pathname;
          const inApp = path.indexOf('/apps/') !== -1;
          const filename = path.split('/').pop() || 'home.html';
          if (!inApp) {
            // Exclude dropdown/sub-list app links: the desktop dropdown's
            // "All Apps" item and the per-app entries share basenames with
            // nothing here, but "All Apps" -> /apps.html would otherwise also
            // match on /apps.html and steal the highlight from the top-level
            // Apps toggle. Match only the top-level inline-nav and #menu links.
            $('.header-inline-nav > a, .nav-apps__toggle, #menu > ul.links > li > a').each(function() {
              const hrefFile = ($(this).attr('href') || '').split('/').pop();
              if (hrefFile && hrefFile === filename) {
                $(this).addClass('active').attr('aria-current', 'page');
              }
            });

            // On the apps hub, the dropdown's "All Apps" item points at the
            // current page; de-emphasise it (purely visual, no aria-current).
            // Extension-tolerant compare for Netlify Pretty URLs: prod serves
            // /apps while the partial href is /apps.html.
            const currentBase = (filename || '').replace(/\.html$/, '') || 'home';
            const $divider = $('.nav-apps__divider');
            const dividerBase = ($divider.find('a').attr('href') || '').split('/').pop().replace(/\.html$/, '');
            if (dividerBase && dividerBase === currentBase) {
              $divider.addClass('is-current-page');
            }
          }
        }

        // Footer: every page shows all five Navigate links so the footer is
        // byte-identical site-wide (no per-page hiding of the current page's
        // link, which previously made the footer one row shorter on the five
        // top-level marketing pages and inconsistent against the app pages).

        // Copyright year. This is done HERE rather than by a <script src>
        // inside the footer partial, and that is the whole point of it.
        //
        // jQuery evaluates a <script> found in injected HTML through
        // _evalUrl -> globalEval -> DOMEval, and DOMEval ends with:
        //     doc.head.appendChild( script ).parentNode.removeChild( script )
        // with no null guard (true in our jQuery 3.2.1 and still true in
        // 3.7). Anything that strips injected <script> nodes back out of
        // <head> - which several common privacy and ad-blocking extensions
        // do - leaves parentNode null, and the page throws
        //     Uncaught TypeError: Cannot read properties of null
        //     (reading 'removeChild')
        // from deep inside jquery.min.js on EVERY page load, with a stack
        // that points at jQuery rather than at us. Filling the year from the
        // include callback deletes that entire code path from the site: no
        // partial ships a script tag any more, so there is nothing for
        // jQuery to eval.
        if (includeFile.indexOf('footer') === 0) {
          const year = new Date().getFullYear();
          // One span per language: the Moadon Alef footer is trilingual and
          // carries year-ru and year-he alongside the shared year.
          ['year', 'year-ru', 'year-he'].forEach((id) => {
            const el = document.getElementById(id);
            if (el) { el.textContent = year; }
          });
        }

        // Anything that must touch an injected partial (language-switcher.js
        // localising the moadon-alef footer) listens for this; DOMContentLoaded
        // fired long before the partial existed.
        document.dispatchEvent(new CustomEvent('shevato:include-loaded', { detail: { file: includeFile } }));
      });
    });

    // Additional auth UI initialization after delay
    setTimeout(() => {
      if (window.authUI && window.authUI.state && $(SELECTORS.authContainer).length > 0 && !window.authUI.state.headerLoaded) {
        window.authUI.onHeaderLoaded();
      }
    }, 1000);
  });

})(jQuery);
