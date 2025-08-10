#!/usr/bin/env node

/**
 * Generate Firebase config file from environment variables
 * This script runs during Netlify build process
 */

const fs = require('fs');
const path = require('path');

// Get Firebase config from environment variables
const config = {
  apiKey: process.env.FIREBASE_API_KEY || '',
  authDomain: process.env.FIREBASE_AUTH_DOMAIN || '',
  projectId: process.env.FIREBASE_PROJECT_ID || '',
  storageBucket: process.env.FIREBASE_STORAGE_BUCKET || '',
  messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID || '',
  appId: process.env.FIREBASE_APP_ID || '',
  measurementId: process.env.FIREBASE_MEASUREMENT_ID || ''
};

// Generate JavaScript file content
const configContent = `/**
 * Firebase Configuration
 * Auto-generated at build time from environment variables
 * Generated at: ${new Date().toISOString()}
 */

window.firebaseConfig = ${JSON.stringify(config, null, 2)};

console.log('Firebase config loaded from build-time generation');
`;

// Write to file
const outputPath = path.join(__dirname, '..', 'assets', 'js', 'firebase-config-generated.js');
fs.writeFileSync(outputPath, configContent);

console.log('Firebase config generated successfully at:', outputPath);
console.log('Config includes:', Object.keys(config).filter(k => config[k]).join(', '));