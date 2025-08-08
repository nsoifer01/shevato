#!/usr/bin/env node

/**
 * Generate Firebase configuration from environment variables
 * This script runs at build time on Netlify
 */

const fs = require('fs');
const path = require('path');

// Get Firebase config from environment variables
const firebaseConfig = {
  apiKey: process.env.FIREBASE_API_KEY || process.env.VITE_FIREBASE_API_KEY || '',
  authDomain: process.env.FIREBASE_AUTH_DOMAIN || process.env.VITE_FIREBASE_AUTH_DOMAIN || '',
  projectId: process.env.FIREBASE_PROJECT_ID || process.env.VITE_FIREBASE_PROJECT_ID || '',
  storageBucket: process.env.FIREBASE_STORAGE_BUCKET || process.env.VITE_FIREBASE_STORAGE_BUCKET || '',
  messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID || process.env.VITE_FIREBASE_MESSAGING_SENDER_ID || '',
  appId: process.env.FIREBASE_APP_ID || process.env.VITE_FIREBASE_APP_ID || '',
  measurementId: process.env.FIREBASE_MEASUREMENT_ID || process.env.VITE_FIREBASE_MEASUREMENT_ID || ''
};

// Generate the JavaScript file content
const configContent = `// Auto-generated Firebase configuration
// Generated at build time from environment variables
window.firebaseConfig = ${JSON.stringify(firebaseConfig, null, 2)};
`;

// Write to assets/js/firebase-config.js
const outputPath = path.join(__dirname, '..', 'assets', 'js', 'firebase-config.js');

try {
  fs.writeFileSync(outputPath, configContent);
  console.log('✅ Firebase configuration generated successfully');
  console.log(`📁 Written to: ${outputPath}`);
  
  // Log what was configured (without sensitive data)
  const configuredKeys = Object.keys(firebaseConfig).filter(key => firebaseConfig[key]);
  console.log(`🔑 Configured keys: ${configuredKeys.join(', ')}`);
} catch (error) {
  console.error('❌ Error generating Firebase configuration:', error);
  process.exit(1);
}