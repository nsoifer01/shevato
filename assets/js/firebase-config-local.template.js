/**
 * Firebase Configuration Template for Local Development
 * 
 * To use this file:
 * 1. Copy this file and rename it to: firebase-config-local.js
 * 2. Fill in your Firebase project configuration values
 * 3. Add firebase-config-local.js to your .gitignore (should already be there)
 * 
 * DO NOT commit firebase-config-local.js to the repository!
 */

window.firebaseConfig = {
  apiKey: "your-api-key-here",
  authDomain: "your-auth-domain.firebaseapp.com",
  projectId: "your-project-id",
  storageBucket: "your-storage-bucket.appspot.com",
  messagingSenderId: "your-sender-id",
  appId: "your-app-id",
  measurementId: "your-measurement-id" // Optional
};

// Alternative: If you prefer to use environment variables locally,
// you can run your local server with environment variables:
// FIREBASE_API_KEY=xxx FIREBASE_AUTH_DOMAIN=xxx npm start