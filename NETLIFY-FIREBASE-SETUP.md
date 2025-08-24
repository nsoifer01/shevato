# Firebase Authentication Setup for Netlify Production

## Overview

This document explains how to configure Firebase authentication to work in both local development and Netlify production environments.

## Architecture

- **Local Development**: Uses `firebase-config-local.js` (not committed to Git)
- **Production (Netlify)**: Uses Netlify Functions to serve Firebase config from environment variables

## Netlify Environment Variables Setup

To make Firebase authentication work in production, you need to add these environment variables in your Netlify dashboard:

### Step 1: Access Netlify Environment Variables

1. Log into your Netlify dashboard
2. Navigate to your site
3. Go to **Site settings** → **Environment variables**

### Step 2: Add Firebase Environment Variables

Add the following environment variables with your Firebase project values:

```
FIREBASE_API_KEY=your-firebase-api-key
FIREBASE_AUTH_DOMAIN=your-project-id.firebaseapp.com
FIREBASE_PROJECT_ID=your-project-id
FIREBASE_STORAGE_BUCKET=your-project-id.firebasestorage.app
FIREBASE_MESSAGING_SENDER_ID=your-sender-id
FIREBASE_APP_ID=your-app-id
FIREBASE_MEASUREMENT_ID=your-measurement-id
```

### Step 3: Deploy

After adding the environment variables:

1. Redeploy your site (or trigger a new build)
2. The Netlify Function will automatically use these environment variables to serve the Firebase config

## How It Works

### Local Development
- The `firebase-config.js` file detects if running locally
- If local, it relies on `firebase-config-local.js` being loaded separately
- The `main.js` waits for config to be available before initializing Firebase

### Production (Netlify)
- The `firebase-config.js` file detects production environment
- It makes a fetch request to `/.netlify/functions/firebase-config`
- The Netlify Function (`netlify/functions/firebase-config.js`) reads environment variables
- Returns JavaScript code that sets `window.firebaseConfig`
- The `main.js` listens for the `firebaseConfigReady` event before initializing

## File Structure

```
assets/js/
├── firebase-config.js              # Main config loader (production + local detection)
├── firebase-config-local.js        # Local config (created, not committed)
├── firebase-config-local.template.js  # Template for local setup
└── main.js                         # Contains FirebaseAuth class

netlify/functions/
└── firebase-config.js              # Netlify Function to serve config from env vars
```

## Security Notes

- **Never commit** `firebase-config-local.js` to Git (already in .gitignore)
- Firebase API keys are not secret for client-side apps - they identify your project
- Security is handled by Firebase Security Rules, not by hiding the config
- Environment variables in Netlify are secure and not exposed to the client

## Testing

### Local Testing
1. Ensure `firebase-config-local.js` exists with your Firebase config
2. Run your local server
3. Check browser console for "Local environment detected" message
4. Verify Firebase authentication works

### Production Testing
1. Ensure environment variables are set in Netlify
2. Deploy your site
3. Check browser console for "Production environment detected" message
4. Check Network tab for successful call to `/.netlify/functions/firebase-config`
5. Verify Firebase authentication works

## Troubleshooting

### Common Issues

1. **Config not loading in production**
   - Check that all environment variables are set in Netlify
   - Verify the Netlify Function is deployed correctly
   - Check browser console for errors

2. **Firebase not initializing**
   - Check that Firebase SDK scripts are loaded before config scripts
   - Verify the config object has all required fields
   - Check browser console for Firebase errors

3. **Authentication not working**
   - Verify Firebase project settings allow your domain
   - Check that auth methods are enabled in Firebase Console
   - Ensure Firebase Security Rules are correctly configured

### Debug Commands

```javascript
// In browser console, check if config is loaded:
console.log(window.firebaseConfig);

// Check if Firebase is initialized:
console.log(firebase.apps);

// Check auth state:
console.log(firebase.auth().currentUser);
```