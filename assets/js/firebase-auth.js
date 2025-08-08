// Firebase Authentication Module
class FirebaseAuth {
  constructor() {
    this.auth = null;
    this.user = null;
    this.initialized = false;
    this.authStateChangeListeners = [];
    
    // Initialize Firebase after a short delay to ensure all dependencies are loaded
    setTimeout(() => {
      this.initialize();
    }, 500);
  }
  
  async initialize() {
    try {
      // Check if all dependencies are available
      if (typeof window.FirebaseConfig === 'undefined') {
        console.warn('FirebaseConfig class not available. Retrying in 1 second...');
        setTimeout(() => this.initialize(), 1000);
        return;
      }
      
      if (typeof firebase === 'undefined') {
        console.warn('Firebase SDK not available. Retrying in 1 second...');
        setTimeout(() => this.initialize(), 1000);
        return;
      }
      
      const firebaseConfigInstance = new window.FirebaseConfig();
      const config = firebaseConfigInstance.getConfig();
      
      if (!config) {
        console.warn('Firebase configuration not available. Authentication disabled.');
        return;
      }
      
      // Wait for Firebase to be loaded from CDN
      await this.waitForFirebase();
      
      // Initialize Firebase app
      const app = firebase.initializeApp(config);
      this.auth = firebase.auth();
      
      // Set up auth state change listener
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
  
  waitForFirebase() {
    return new Promise((resolve, reject) => {
      let attempts = 0;
      const maxAttempts = 50; // 5 seconds max wait
      
      const checkFirebase = () => {
        if (typeof firebase !== 'undefined') {
          resolve();
        } else if (attempts < maxAttempts) {
          attempts++;
          setTimeout(checkFirebase, 100);
        } else {
          reject(new Error('Firebase not loaded'));
        }
      };
      
      checkFirebase();
    });
  }
  
  // Auth state change listeners
  onAuthStateChange(callback) {
    this.authStateChangeListeners.push(callback);
    // If already initialized and has user state, call immediately
    if (this.initialized) {
      callback(this.user);
    }
  }
  
  notifyAuthStateChange(user) {
    this.authStateChangeListeners.forEach(callback => {
      try {
        callback(user);
      } catch (error) {
        console.error('Auth state change listener error:', error);
      }
    });
  }
  
  // Sign up with email and password
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
  
  // Sign in with email and password
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
  
  // Sign in with Google
  async signInWithGoogle() {
    if (!this.initialized) {
      throw new Error('Firebase Auth not initialized');
    }
    
    try {
      const provider = new firebase.auth.GoogleAuthProvider();
      const userCredential = await this.auth.signInWithPopup(provider);
      return userCredential.user;
    } catch (error) {
      console.error('Google sign in error:', error);
      throw this.formatAuthError(error);
    }
  }
  
  // Sign out
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
  
  // Get current user
  getCurrentUser() {
    return this.user;
  }
  
  // Check if user is signed in
  isSignedIn() {
    return this.user !== null;
  }
  
  // Format Firebase auth errors for user display
  formatAuthError(error) {
    const errorMessages = {
      'auth/user-not-found': 'No account found with this email address.',
      'auth/wrong-password': 'Incorrect password.',
      'auth/email-already-in-use': 'An account with this email already exists.',
      'auth/weak-password': 'Password should be at least 6 characters.',
      'auth/invalid-email': 'Please enter a valid email address.',
      'auth/too-many-requests': 'Too many failed attempts. Please try again later.',
      'auth/popup-closed-by-user': 'Sign-in popup was closed.',
      'auth/cancelled-popup-request': 'Sign-in was cancelled.'
    };
    
    return new Error(errorMessages[error.code] || error.message);
  }
  
  // Check if Firebase Auth is available
  isAvailable() {
    return this.initialized;
  }
}

// Create global instance
window.firebaseAuth = new FirebaseAuth();