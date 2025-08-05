// Authentication UI Components
import firebaseAuth from './firebase-auth.js';

class AuthUI {
  constructor() {
    this.currentModal = null;
    this.init();
  }

  init() {
    // Wait for DOM to be ready
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => this.setupEventListeners());
    } else {
      this.setupEventListeners();
    }
  }

  setupEventListeners() {
    // Sign in button
    const signInBtn = document.getElementById('sign-in-btn');
    if (signInBtn) {
      signInBtn.addEventListener('click', (e) => {
        e.preventDefault();
        this.showSignInModal();
      });
    }

    // Sign up button  
    const signUpBtn = document.getElementById('sign-up-btn');
    if (signUpBtn) {
      signUpBtn.addEventListener('click', (e) => {
        e.preventDefault();
        this.showSignUpModal();
      });
    }

    // Sign out button
    const signOutBtn = document.getElementById('sign-out-btn');
    if (signOutBtn) {
      signOutBtn.addEventListener('click', (e) => {
        e.preventDefault();
        this.handleSignOut();
      });
    }

    // Close modal when clicking outside
    document.addEventListener('click', (e) => {
      if (e.target.classList.contains('auth-modal')) {
        this.closeModal();
      }
    });

    // Close modal with Escape key
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.currentModal) {
        this.closeModal();
      }
    });
  }

  showSignInModal() {
    const modal = this.createModal('Sign In', this.getSignInForm());
    document.body.appendChild(modal);
    this.currentModal = modal;
    
    // Add event listeners for the form
    const form = modal.querySelector('#sign-in-form');
    form.addEventListener('submit', (e) => this.handleSignIn(e));
    
    const switchToSignUp = modal.querySelector('#switch-to-signup');
    switchToSignUp.addEventListener('click', (e) => {
      e.preventDefault();
      this.closeModal();
      this.showSignUpModal();
    });
  }

  showSignUpModal() {
    const modal = this.createModal('Create Account', this.getSignUpForm());
    document.body.appendChild(modal);
    this.currentModal = modal;
    
    // Add event listeners for the form
    const form = modal.querySelector('#sign-up-form');
    form.addEventListener('submit', (e) => this.handleSignUp(e));
    
    const switchToSignIn = modal.querySelector('#switch-to-signin');
    switchToSignIn.addEventListener('click', (e) => {
      e.preventDefault();
      this.closeModal();
      this.showSignInModal();
    });
  }

  createModal(title, content) {
    const modal = document.createElement('div');
    modal.className = 'auth-modal';
    modal.innerHTML = `
      <div class="auth-modal-content">
        <div class="auth-modal-header">
          <h3>${title}</h3>
          <button class="auth-modal-close" onclick="authUI.closeModal()">&times;</button>
        </div>
        <div class="auth-modal-body">
          ${content}
        </div>
      </div>
    `;
    return modal;
  }

  getSignInForm() {
    return `
      <div class="auth-info">
        <p><i class="fa fa-info-circle"></i> <strong>Sign in is optional!</strong></p>
        <p>Your progress is automatically saved locally. Sign in only if you want to sync your data across multiple devices.</p>
      </div>
      
      <form id="sign-in-form">
        <div class="form-group">
          <label for="signin-email">Email Address</label>
          <input type="email" id="signin-email" required autocomplete="email">
        </div>
        
        <div class="form-group">
          <label for="signin-password">Password</label>
          <input type="password" id="signin-password" required autocomplete="current-password">
        </div>
        
        <div class="form-actions">
          <button type="submit" class="btn-primary">Sign In</button>
        </div>
        
        <div class="form-footer">
          <p>Don't have an account? <a href="#" id="switch-to-signup">Create one</a></p>
        </div>
      </form>
      
      <div id="signin-message" class="auth-message"></div>
    `;
  }

  getSignUpForm() {
    return `
      <div class="auth-info">
        <p><i class="fa fa-info-circle"></i> <strong>Account creation is optional!</strong></p>
        <p>Create an account only if you want to sync your progress across devices. All your data remains stored locally regardless.</p>
      </div>
      
      <form id="sign-up-form">
        <div class="form-group">
          <label for="signup-name">Display Name (Optional)</label>
          <input type="text" id="signup-name" placeholder="How should we address you?" autocomplete="name">
        </div>
        
        <div class="form-group">
          <label for="signup-email">Email Address</label>
          <input type="email" id="signup-email" required autocomplete="email">
        </div>
        
        <div class="form-group">
          <label for="signup-password">Password</label>
          <input type="password" id="signup-password" required minlength="6" autocomplete="new-password">
          <small>Password must be at least 6 characters long</small>
        </div>
        
        <div class="form-group">
          <label for="signup-confirm-password">Confirm Password</label>
          <input type="password" id="signup-confirm-password" required minlength="6" autocomplete="new-password">
        </div>
        
        <div class="form-actions">
          <button type="submit" class="btn-primary">Create Account</button>
        </div>
        
        <div class="form-footer">
          <p>Already have an account? <a href="#" id="switch-to-signin">Sign in</a></p>
        </div>
      </form>
      
      <div id="signup-message" class="auth-message"></div>
    `;
  }

  async handleSignIn(e) {
    e.preventDefault();
    
    const email = document.getElementById('signin-email').value.trim();
    const password = document.getElementById('signin-password').value;
    const messageEl = document.getElementById('signin-message');
    const submitBtn = e.target.querySelector('button[type="submit"]');
    
    // Show loading state
    submitBtn.disabled = true;
    submitBtn.textContent = 'Signing In...';
    messageEl.textContent = '';
    
    try {
      const result = await firebaseAuth.signIn(email, password);
      
      if (result.success) {
        messageEl.innerHTML = `<i class="fa fa-check"></i> ${result.message}`;
        messageEl.className = 'auth-message success';
        
        // Close modal after short delay
        setTimeout(() => {
          this.closeModal();
        }, 1500);
      } else {
        messageEl.innerHTML = `<i class="fa fa-exclamation-triangle"></i> ${result.message}`;
        messageEl.className = 'auth-message error';
      }
    } catch (error) {
      messageEl.innerHTML = `<i class="fa fa-exclamation-triangle"></i> An unexpected error occurred.`;
      messageEl.className = 'auth-message error';
    }
    
    // Reset button
    submitBtn.disabled = false;
    submitBtn.textContent = 'Sign In';
  }

  async handleSignUp(e) {
    e.preventDefault();
    
    const displayName = document.getElementById('signup-name').value.trim();
    const email = document.getElementById('signup-email').value.trim();
    const password = document.getElementById('signup-password').value;
    const confirmPassword = document.getElementById('signup-confirm-password').value;
    const messageEl = document.getElementById('signup-message');
    const submitBtn = e.target.querySelector('button[type="submit"]');
    
    // Validate passwords match
    if (password !== confirmPassword) {
      messageEl.innerHTML = `<i class="fa fa-exclamation-triangle"></i> Passwords do not match.`;
      messageEl.className = 'auth-message error';
      return;
    }
    
    // Show loading state
    submitBtn.disabled = true;
    submitBtn.textContent = 'Creating Account...';
    messageEl.textContent = '';
    
    try {
      const result = await firebaseAuth.signUp(email, password, displayName);
      
      if (result.success) {
        messageEl.innerHTML = `<i class="fa fa-check"></i> ${result.message}`;
        messageEl.className = 'auth-message success';
        
        // Close modal after short delay
        setTimeout(() => {
          this.closeModal();
        }, 1500);
      } else {
        messageEl.innerHTML = `<i class="fa fa-exclamation-triangle"></i> ${result.message}`;
        messageEl.className = 'auth-message error';
      }
    } catch (error) {
      messageEl.innerHTML = `<i class="fa fa-exclamation-triangle"></i> An unexpected error occurred.`;
      messageEl.className = 'auth-message error';
    }
    
    // Reset button
    submitBtn.disabled = false;
    submitBtn.textContent = 'Create Account';
  }

  async handleSignOut() {
    const result = await firebaseAuth.signOutUser();
    
    if (result.success) {
      // Show temporary success message
      this.showTemporaryMessage(result.message, 'success');
    } else {
      this.showTemporaryMessage(result.message, 'error');
    }
  }

  showTemporaryMessage(message, type) {
    const messageEl = document.createElement('div');
    messageEl.className = `auth-temp-message ${type}`;
    messageEl.innerHTML = `<i class="fa fa-${type === 'success' ? 'check' : 'exclamation-triangle'}"></i> ${message}`;
    
    document.body.appendChild(messageEl);
    
    // Remove after 3 seconds
    setTimeout(() => {
      if (messageEl.parentNode) {
        messageEl.parentNode.removeChild(messageEl);
      }
    }, 3000);
  }

  closeModal() {
    if (this.currentModal) {
      document.body.removeChild(this.currentModal);
      this.currentModal = null;
    }
  }
}

// Create and export singleton instance
const authUI = new AuthUI();

// Make it globally accessible for modal close button
window.authUI = authUI;

export default authUI;
