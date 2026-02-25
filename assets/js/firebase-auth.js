/**
 * Firebase Authentication Class
 * Handles Firebase auth initialization, sign in/up/out, and state management.
 *
 * Dependencies: Firebase SDK (loaded from CDN as global)
 */

export class FirebaseAuth {
  constructor() {
    this.auth = null;
    this.user = null;
    this.initialized = false;
    this.authStateChangeListeners = [];

    // Initialize immediately - config is already loaded from firebase-config.js
    this.initialize();
  }

  /**
   * Initialize Firebase authentication
   * @async
   */
  async initialize() {
    try {
      // Wait for Firebase SDK if not ready
      if (typeof firebase === 'undefined') {
        setTimeout(() => this.initialize(), 100);
        return;
      }

      // Use window.firebaseConfig directly (loaded from firebase-config.js)
      const config = window.firebaseConfig;

      if (!config || !config.apiKey || !config.authDomain || !config.projectId) {
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
    this.authStateChangeListeners.forEach((callback) => {
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
      'auth/invalid-login-credentials':
        'Invalid email or password. Please check your credentials and try again.',
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
