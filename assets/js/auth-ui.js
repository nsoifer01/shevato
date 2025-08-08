// Authentication UI Components
class AuthUI {
  constructor() {
    this.isModalOpen = false;
    this.currentUser = null;
    this.headerLoaded = false;
    
    // Wait for Firebase Auth to be ready
    if (window.firebaseAuth) {
      window.firebaseAuth.onAuthStateChange(user => this.handleAuthStateChange(user));
    }
    
    // Initialize UI when DOM is ready
    $(document).ready(() => {
      this.createAuthModal();
      this.bindEvents();
      this.waitForHeader();
    });
  }
  
  // Wait for the header to be loaded by the include system
  waitForHeader() {
    const checkHeader = () => {
      const authContainer = $('#auth-container');
      if (authContainer.length > 0) {
        this.headerLoaded = true;
        this.updateHeaderUI();
      } else {
        // Check again in 100ms
        setTimeout(checkHeader, 100);
      }
    };
    checkHeader();
  }
  
  // Called by main.js when header is loaded
  onHeaderLoaded() {
    this.headerLoaded = true;
    this.updateHeaderUI();
  }
  
  handleAuthStateChange(user) {
    this.currentUser = user;
    if (this.headerLoaded) {
      this.updateHeaderUI();
    }
  }
  
  updateHeaderUI() {
    const authContainer = $('#auth-container');
    if (!authContainer.length || !this.headerLoaded) return;
    
    // Check if Firebase Auth is available
    if (!this.isAuthAvailable()) {
      // Firebase not configured - show sign-in button that explains the situation
      authContainer.html(`
        <div class="auth-signin-prompt">
          <button id="auth-signin-btn" class="auth-button auth-signin">Sign In</button>
        </div>
      `);
      this.bindHeaderEvents();
      return;
    }
    
    if (this.currentUser) {
      // User is signed in
      const displayName = this.currentUser.displayName || this.currentUser.email;
      authContainer.html(`
        <div class="auth-user-info">
          <span class="user-name">${displayName}</span>
          <button id="auth-signout-btn" class="auth-button auth-signout">Sign Out</button>
        </div>
      `);
    } else {
      // User is not signed in but auth is available
      authContainer.html(`
        <div class="auth-signin-prompt">
          <button id="auth-signin-btn" class="auth-button auth-signin">Sign In</button>
        </div>
      `);
    }
    
    // Rebind events for new elements
    this.bindHeaderEvents();
  }
  
  bindHeaderEvents() {
    $('#auth-signin-btn').off('click').on('click', (e) => {
      e.preventDefault();
      this.showAuthModal();
    });
    
    $('#auth-signout-btn').off('click').on('click', async (e) => {
      e.preventDefault();
      try {
        await window.firebaseAuth.signOut();
        this.showMessage('Signed out successfully', 'success');
      } catch (error) {
        this.showMessage('Error signing out: ' + error.message, 'error');
      }
    });
  }
  
  createAuthModal() {
    const modalHtml = `
      <div id="auth-modal" class="auth-modal" style="display: none;">
        <div class="auth-modal-content">
          <div class="auth-modal-header">
            <h3>Sign In to Sync Your Progress</h3>
            <button class="auth-modal-close">&times;</button>
          </div>
          
          <div class="auth-sync-message">
            <p><strong>Signing in is optional!</strong> Your progress is automatically saved in your browser. 
            Sign in only if you want to sync your progress across multiple devices.</p>
          </div>
          
          <div class="auth-tabs">
            <button class="auth-tab active" data-tab="signin">Sign In</button>
            <button class="auth-tab" data-tab="signup">Sign Up</button>
          </div>
          
          <div class="auth-content">
            <div id="auth-signin-form" class="auth-form active">
              <form>
                <div class="auth-field">
                  <input type="email" id="signin-email" placeholder="Email" autocomplete="email" required>
                </div>
                <div class="auth-field">
                  <input type="password" id="signin-password" placeholder="Password" autocomplete="current-password" required>
                </div>
                <button type="submit" class="auth-button auth-primary">Sign In</button>
              </form>
              
              <div class="auth-divider">
                <span>or</span>
              </div>
              
              <button id="google-signin-btn" class="auth-button auth-google">
                <span class="google-icon">G</span>
                Sign in with Google
              </button>
            </div>
            
            <div id="auth-signup-form" class="auth-form">
              <form>
                <div class="auth-field">
                  <input type="email" id="signup-email" placeholder="Email" autocomplete="email" required>
                </div>
                <div class="auth-field">
                  <input type="password" id="signup-password" placeholder="Password (min 6 characters)" autocomplete="new-password" required>
                </div>
                <button type="submit" class="auth-button auth-primary">Create Account</button>
              </form>
              
              <div class="auth-divider">
                <span>or</span>
              </div>
              
              <button id="google-signup-btn" class="auth-button auth-google">
                <span class="google-icon">G</span>
                Sign up with Google
              </button>
            </div>
          </div>
          
          <div id="auth-message" class="auth-message"></div>
        </div>
      </div>
    `;
    
    $('body').append(modalHtml);
  }
  
  bindEvents() {
    // Modal close events
    $('.auth-modal-close, #auth-modal').on('click', (e) => {
      if (e.target === e.currentTarget) {
        this.hideAuthModal();
      }
    });
    
    // Tab switching
    $('.auth-tab').on('click', (e) => {
      const tab = $(e.target).data('tab');
      this.switchTab(tab);
    });
    
    // Form submissions
    $('#auth-signin-form form').on('submit', async (e) => {
      e.preventDefault();
      await this.handleEmailSignIn();
    });
    
    $('#auth-signup-form form').on('submit', async (e) => {
      e.preventDefault();
      await this.handleEmailSignUp();
    });
    
    // Google sign in buttons
    $('#google-signin-btn, #google-signup-btn').on('click', async (e) => {
      e.preventDefault();
      await this.handleGoogleSignIn();
    });
    
    // ESC key to close modal
    $(document).on('keydown', (e) => {
      if (e.key === 'Escape' && this.isModalOpen) {
        this.hideAuthModal();
      }
    });
  }
  
  switchTab(tab) {
    $('.auth-tab').removeClass('active');
    $('.auth-form').removeClass('active');
    
    $(`.auth-tab[data-tab="${tab}"]`).addClass('active');
    $(`#auth-${tab}-form`).addClass('active');
    
    this.clearMessage();
  }
  
  showAuthModal() {
    // Check if Firebase is configured
    if (!this.isAuthAvailable()) {
      alert('Firebase authentication is not configured yet. Please see setup-firebase.md for instructions.');
      return;
    }
    
    this.isModalOpen = true;
    $('#auth-modal').fadeIn(200);
    $('body').addClass('auth-modal-open');
  }
  
  hideAuthModal() {
    this.isModalOpen = false;
    $('#auth-modal').fadeOut(200);
    $('body').removeClass('auth-modal-open');
    this.clearMessage();
    this.clearForms();
  }
  
  async handleEmailSignIn() {
    const email = $('#signin-email').val();
    const password = $('#signin-password').val();
    
    if (!email || !password) {
      this.showMessage('Please fill in all fields', 'error');
      return;
    }
    
    try {
      this.showMessage('Signing in...', 'info');
      await window.firebaseAuth.signIn(email, password);
      this.showMessage('Signed in successfully!', 'success');
      setTimeout(() => this.hideAuthModal(), 1000);
    } catch (error) {
      this.showMessage(error.message, 'error');
    }
  }
  
  async handleEmailSignUp() {
    const email = $('#signup-email').val();
    const password = $('#signup-password').val();
    
    if (!email || !password) {
      this.showMessage('Please fill in all fields', 'error');
      return;
    }
    
    if (password.length < 6) {
      this.showMessage('Password must be at least 6 characters', 'error');
      return;
    }
    
    try {
      this.showMessage('Creating account...', 'info');
      await window.firebaseAuth.signUp(email, password);
      this.showMessage('Account created successfully!', 'success');
      setTimeout(() => this.hideAuthModal(), 1000);
    } catch (error) {
      this.showMessage(error.message, 'error');
    }
  }
  
  async handleGoogleSignIn() {
    try {
      this.showMessage('Opening Google sign in...', 'info');
      await window.firebaseAuth.signInWithGoogle();
      this.showMessage('Signed in with Google!', 'success');
      setTimeout(() => this.hideAuthModal(), 1000);
    } catch (error) {
      if (error.message.includes('popup')) {
        this.showMessage('Sign-in popup was closed. Please try again.', 'error');
      } else {
        this.showMessage(error.message, 'error');
      }
    }
  }
  
  showMessage(message, type = 'info') {
    const messageEl = $('#auth-message');
    messageEl.removeClass('success error info warning')
           .addClass(type)
           .text(message)
           .show();
  }
  
  clearMessage() {
    $('#auth-message').hide().text('');
  }
  
  clearForms() {
    $('#auth-signin-form form')[0].reset();
    $('#auth-signup-form form')[0].reset();
  }
  
  // Check if Firebase Auth is available
  isAuthAvailable() {
    return window.firebaseAuth && window.firebaseAuth.isAvailable();
  }
}

// Initialize Auth UI when ready
$(document).ready(() => {
  // Create auth UI instance
  window.authUI = new AuthUI();
  
  // Also trigger a manual check after a short delay in case the header is already loaded
  setTimeout(() => {
    if (window.authUI && $('#auth-container').length > 0 && !window.authUI.headerLoaded) {
      window.authUI.onHeaderLoaded();
    }
  }, 1000);
});