// Firebase Authentication Module
import { auth } from './firebase-config.js';
import { 
  createUserWithEmailAndPassword, 
  signInWithEmailAndPassword, 
  signOut,
  onAuthStateChanged,
  updateProfile
} from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js';

class FirebaseAuth {
  constructor() {
    this.currentUser = null;
    this.authStateCallbacks = [];
    this.init();
  }

  init() {
    // Listen for authentication state changes
    onAuthStateChanged(auth, (user) => {
      this.currentUser = user;
      this.notifyAuthStateChange(user);
      this.updateUI(user);
    });
  }

  // Register a callback for auth state changes
  onAuthStateChange(callback) {
    this.authStateCallbacks.push(callback);
  }

  // Notify all registered callbacks of auth state changes
  notifyAuthStateChange(user) {
    this.authStateCallbacks.forEach(callback => {
      try {
        callback(user);
      } catch (error) {
        console.error('Error in auth state callback:', error);
      }
    });
  }

  // Sign up with email and password
  async signUp(email, password, displayName = '') {
    try {
      const userCredential = await createUserWithEmailAndPassword(auth, email, password);
      const user = userCredential.user;
      
      // Update display name if provided
      if (displayName && displayName.trim()) {
        await updateProfile(user, {
          displayName: displayName.trim()
        });
        
        // Refresh the current user to get updated profile
        await user.reload();
        
        return {
          success: true,
          user: user,
          message: `Welcome ${displayName.trim()}! Account created successfully.`
        };
      }
      
      return {
        success: true,
        user: user,
        message: 'Account created successfully!'
      };
    } catch (error) {
      return {
        success: false,
        error: error.code,
        message: this.getErrorMessage(error.code)
      };
    }
  }

  // Sign in with email and password
  async signIn(email, password) {
    try {
      const userCredential = await signInWithEmailAndPassword(auth, email, password);
      const user = userCredential.user;
      
      // Personalized welcome message
      const displayName = user.displayName?.trim();
      const welcomeMessage = displayName 
        ? `Welcome back, ${displayName}!` 
        : 'Signed in successfully!';
      
      return {
        success: true,
        user: user,
        message: welcomeMessage
      };
    } catch (error) {
      return {
        success: false,
        error: error.code,
        message: this.getErrorMessage(error.code)
      };
    }
  }

  // Sign out
  async signOutUser() {
    try {
      await signOut(auth);
      return {
        success: true,
        message: 'Signed out successfully!'
      };
    } catch (error) {
      return {
        success: false,
        error: error.code,
        message: 'Error signing out. Please try again.'
      };
    }
  }

  // Get current user
  getCurrentUser() {
    return this.currentUser;
  }

  // Check if user is signed in
  isSignedIn() {
    return this.currentUser !== null;
  }

  // Get user display name
  getUserDisplayName() {
    if (this.currentUser) {
      // Prioritize display name, fallback to email, then generic 'User'
      return this.currentUser.displayName || this.currentUser.email || 'User';
    }
    return null;
  }

  // Get user display name for header (prefer display name over email)
  getUserDisplayNameForHeader() {
    if (this.currentUser) {
      if (this.currentUser.displayName && this.currentUser.displayName.trim()) {
        return this.currentUser.displayName.trim();
      }
      // Only show email if no display name is set
      return this.currentUser.email || 'User';
    }
    return null;
  }

  // Get user email
  getUserEmail() {
    return this.currentUser ? this.currentUser.email : null;
  }

  // Convert Firebase error codes to user-friendly messages
  getErrorMessage(errorCode) {
    const errorMessages = {
      'auth/email-already-in-use': 'This email address is already registered. Please sign in instead.',
      'auth/invalid-email': 'Please enter a valid email address.',
      'auth/operation-not-allowed': 'Email/password accounts are not enabled. Please contact support.',
      'auth/weak-password': 'Password should be at least 6 characters long.',
      'auth/user-disabled': 'This account has been disabled. Please contact support.',
      'auth/user-not-found': 'No account found with this email address.',
      'auth/wrong-password': 'Incorrect password. Please try again.',
      'auth/invalid-credential': 'Invalid email or password. Please check your credentials.',
      'auth/too-many-requests': 'Too many failed attempts. Please try again later.',
      'auth/network-request-failed': 'Network error. Please check your connection and try again.'
    };
    
    return errorMessages[errorCode] || 'An unexpected error occurred. Please try again.';
  }

  // Update UI based on authentication state
  updateUI(user) {
    const authContainer = document.getElementById('auth-container');
    const authStatus = document.getElementById('auth-status');
    const signInBtn = document.getElementById('sign-in-btn');
    const signUpBtn = document.getElementById('sign-up-btn');
    const signOutBtn = document.getElementById('sign-out-btn');
    const userInfo = document.getElementById('user-info');
    const authSeparator = document.querySelector('.auth-separator');

    if (!authContainer) return; // Auth UI not loaded yet

    if (user) {
      // User is signed in
      if (signInBtn) signInBtn.style.display = 'none';
      if (signUpBtn) signUpBtn.style.display = 'none';
      if (authSeparator) authSeparator.style.display = 'none';
      if (signOutBtn) signOutBtn.style.display = 'inline-flex';
      if (userInfo) {
        userInfo.style.display = 'inline-flex';
        const emailSpan = userInfo.querySelector('.user-email');
        if (emailSpan) {
          const displayText = this.getUserDisplayNameForHeader();
          emailSpan.textContent = displayText;
          
          // Add title attribute for tooltip - show email if display name is shown
          if (this.currentUser.displayName && this.currentUser.displayName.trim()) {
            emailSpan.title = `Signed in as: ${this.currentUser.email}`;
          } else {
            emailSpan.title = `Signed in as: ${this.currentUser.email}`;
          }
        }
      }
      if (authStatus) {
        authStatus.innerHTML = '<i class="fa fa-check-circle"></i> Syncing across devices';
        authStatus.className = 'auth-status signed-in';
      }
    } else {
      // User is signed out
      if (signInBtn) signInBtn.style.display = 'inline-flex';
      if (signUpBtn) signUpBtn.style.display = 'inline-flex';
      if (authSeparator) authSeparator.style.display = 'inline';
      if (signOutBtn) signOutBtn.style.display = 'none';
      if (userInfo) userInfo.style.display = 'none';
      if (authStatus) {
        authStatus.innerHTML = '<i class="fa fa-cloud-upload"></i> Optional - Sync across devices';
        authStatus.className = 'auth-status signed-out';
      }
    }
  }
}

// Create and export a singleton instance
const firebaseAuth = new FirebaseAuth();
export default firebaseAuth;