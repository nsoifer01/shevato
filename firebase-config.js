// Firebase configuration module - initialize app and Firestore
// Uses modular v9+ SDK via CDN imports

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { getDatabase } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-database.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";

// Your Firebase config - using actual project credentials
const firebaseConfig = {
  apiKey: "AIzaSyDlawczS-pufHS_Oi5LUeU_EzcwTFyU_2I",
  authDomain: "shevato-site.firebaseapp.com",
  projectId: "shevato-site",
  storageBucket: "shevato-site.firebasestorage.app",
  messagingSenderId: "1082724320778",
  appId: "1:1082724320778:web:e374cbaeeae1bdaeee81f3",
  measurementId: "G-2C9F2PCXHP",
  databaseURL: "https://shevato-site-default-rtdb.firebaseio.com/" // Required for Realtime Database
};

// Initialize Firebase app
const app = initializeApp(firebaseConfig);

// Initialize services
export const auth = getAuth(app);
export const db = getFirestore(app);
export const rtdb = getDatabase(app);

// Expose config to window for compat SDK (used by main.js auth)
window.firebaseConfig = firebaseConfig;

export { app };
