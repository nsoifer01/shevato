#!/usr/bin/env node

/**
 * Build-time script to generate Firebase config from environment variables
 * This runs during Netlify build process
 */

const fs = require('fs');
const path = require('path');

// Get config from environment variables (available at build time)
const config = {
  apiKey: process.env.FIREBASE_API_KEY || '',
  authDomain: process.env.FIREBASE_AUTH_DOMAIN || '',
  projectId: process.env.FIREBASE_PROJECT_ID || '',
  storageBucket: process.env.FIREBASE_STORAGE_BUCKET || '',
  messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID || '',
  appId: process.env.FIREBASE_APP_ID || '',
  measurementId: process.env.FIREBASE_MEASUREMENT_ID || ''
};

// Check if we have the required config
const hasConfig = config.apiKey && config.authDomain && config.projectId;

if (!hasConfig) {
  console.warn('Warning: Firebase configuration is incomplete.');
  console.warn('Make sure environment variables are set in Netlify with BUILD scope.');
  console.warn('Creating empty config file...');
}

// Generate the JavaScript file
const configContent = `/**
 * Firebase Configuration
 * Auto-generated at build time - DO NOT EDIT
 * Generated: ${new Date().toISOString()}
 */

window.firebaseConfig = ${JSON.stringify(config, null, 2)};
`;

// Write to assets/js/firebase-config.js
const outputPath = path.join(__dirname, '..', 'assets', 'js', 'firebase-config.js');
fs.writeFileSync(outputPath, configContent);

console.log(`✓ Firebase config generated at: ${outputPath}`);
console.log(`  API Key present: ${!!config.apiKey}`);
console.log(`  Auth Domain present: ${!!config.authDomain}`);
console.log(`  Project ID present: ${!!config.projectId}`);