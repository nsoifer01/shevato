// Firebase Configuration
// Import the functions you need from the SDKs you need
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js';
import { getAuth } from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js';
import { getAnalytics } from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-analytics.js';

// Your web app's Firebase configuration
const firebaseConfig = {
  apiKey: "AIzaSyAZtlhHxcKomG0MYi9PCAqUmHTLktC85Zs",
  authDomain: "shevato-697c5.firebaseapp.com",
  projectId: "shevato-697c5",
  storageBucket: "shevato-697c5.firebasestorage.app",
  messagingSenderId: "270744827994",
  appId: "1:270744827994:web:5ac1853904611359c60063",
  measurementId: "G-JKXXPSGG2B"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);

// Initialize Firebase Authentication and get a reference to the service
export const auth = getAuth(app);

// Initialize Analytics (optional)
let analytics;
try {
  analytics = getAnalytics(app);
} catch (error) {
  console.log('Analytics not available:', error);
}

export { analytics };
export default app;