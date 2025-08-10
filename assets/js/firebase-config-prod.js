/**
 * Firebase Configuration for Production
 * This file will be used in production with Netlify snippet injection
 * 
 * To set up:
 * 1. In Netlify dashboard, go to Site Settings > Build & Deploy > Post processing > Snippet injection
 * 2. Add "Before </body>" snippet with:
 * 
 * <script>
 * window.firebaseConfig = {
 *   apiKey: "YOUR_API_KEY",
 *   authDomain: "YOUR_AUTH_DOMAIN",
 *   projectId: "YOUR_PROJECT_ID",
 *   storageBucket: "YOUR_STORAGE_BUCKET",
 *   messagingSenderId: "YOUR_SENDER_ID",
 *   appId: "YOUR_APP_ID"
 * };
 * </script>
 */

// This file intentionally left mostly empty
// The actual config will be injected by Netlify snippet
if (!window.firebaseConfig) {
  window.firebaseConfig = {};
  console.info('Waiting for Firebase config from Netlify snippet injection...');
}