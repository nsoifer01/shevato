// Example: Integrating Firebase Auth with localStorage
// This file demonstrates how to sync user data while keeping localStorage as primary storage

import firebaseAuth from './firebase-auth.js';

class DataSyncManager {
  constructor() {
    this.storageKey = 'userData';
    this.init();
  }

  init() {
    // Listen for authentication state changes
    firebaseAuth.onAuthStateChange((user) => {
      if (user) {
        console.log('User signed in:', user.email);
        // Optionally sync data when user signs in
        this.onUserSignIn(user);
      } else {
        console.log('User signed out');
        // Data remains in localStorage when user signs out
        this.onUserSignOut();
      }
    });
  }

  // Get data from localStorage (always the primary source)
  getUserData() {
    try {
      const data = localStorage.getItem(this.storageKey);
      return data ? JSON.parse(data) : {};
    } catch (error) {
      console.error('Error reading from localStorage:', error);
      return {};
    }
  }

  // Save data to localStorage (always the primary action)
  saveUserData(data) {
    try {
      localStorage.setItem(this.storageKey, JSON.stringify(data));
      
      // If user is signed in, optionally sync to cloud
      if (firebaseAuth.isSignedIn()) {
        this.syncToCloud(data);
      }
      
      return true;
    } catch (error) {
      console.error('Error saving to localStorage:', error);
      return false;
    }
  }

  // Called when user signs in
  onUserSignIn(user) {
    // Example: Show sync status
    this.showSyncStatus('Connected - Data will sync across devices');
    
    // Optionally: Load cloud data and merge with local data
    // this.loadFromCloud();
  }

  // Called when user signs out
  onUserSignOut() {
    // Show local storage status
    this.showSyncStatus('Disconnected - Data saved locally only');
    
    // Note: We deliberately do NOT clear localStorage on sign out
    // This ensures users don't lose their data when signing out
  }

  // Optional: Sync to cloud storage (Firestore example)
  async syncToCloud(data) {
    if (!firebaseAuth.isSignedIn()) {
      return;
    }

    try {
      // Example implementation would use Firestore
      // const db = getFirestore();
      // const userDoc = doc(db, 'users', firebaseAuth.getCurrentUser().uid);
      // await setDoc(userDoc, data, { merge: true });
      
      console.log('Data synced to cloud (implementation needed)');
      this.showSyncStatus('Synced to cloud ✓');
    } catch (error) {
      console.error('Cloud sync failed:', error);
      this.showSyncStatus('Sync failed - Data saved locally');
    }
  }

  // Optional: Load from cloud storage
  async loadFromCloud() {
    if (!firebaseAuth.isSignedIn()) {
      return null;
    }

    try {
      // Example implementation would use Firestore
      // const db = getFirestore();
      // const userDoc = doc(db, 'users', firebaseAuth.getCurrentUser().uid);
      // const docSnap = await getDoc(userDoc);
      // return docSnap.exists() ? docSnap.data() : null;
      
      console.log('Load from cloud (implementation needed)');
      return null;
    } catch (error) {
      console.error('Failed to load from cloud:', error);
      return null;
    }
  }

  // Show sync status to user
  showSyncStatus(message) {
    const statusElement = document.getElementById('sync-status');
    if (statusElement) {
      statusElement.textContent = message;
    }
  }

  // Example: Save user preference
  saveUserPreference(key, value) {
    const userData = this.getUserData();
    userData[key] = value;
    return this.saveUserData(userData);
  }

  // Example: Get user preference
  getUserPreference(key, defaultValue = null) {
    const userData = this.getUserData();
    return userData[key] !== undefined ? userData[key] : defaultValue;
  }

  // Example: Save game/app progress
  saveProgress(appName, progressData) {
    const userData = this.getUserData();
    if (!userData.progress) {
      userData.progress = {};
    }
    userData.progress[appName] = {
      ...progressData,
      lastUpdated: new Date().toISOString()
    };
    return this.saveUserData(userData);
  }

  // Example: Get game/app progress
  getProgress(appName) {
    const userData = this.getUserData();
    return userData.progress && userData.progress[appName] 
      ? userData.progress[appName] 
      : null;
  }
}

// Example usage in your apps:
// 
// const dataSyncManager = new DataSyncManager();
// 
// // Save progress (works whether user is signed in or not)
// dataSyncManager.saveProgress('mario-kart', {
//   totalRaces: 150,
//   favoriteTrack: 'Rainbow Road',
//   highScore: 2500
// });
// 
// // Get progress (always from localStorage first)
// const marioKartProgress = dataSyncManager.getProgress('mario-kart');
// 
// // Save user preferences
// dataSyncManager.saveUserPreference('theme', 'dark');
// dataSyncManager.saveUserPreference('notifications', true);

// Create and export singleton instance
const dataSyncManager = new DataSyncManager();
export default dataSyncManager;