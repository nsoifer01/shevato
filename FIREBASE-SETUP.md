# Firebase Configuration Setup

This project uses a secure Firebase configuration that works both locally and in production without exposing sensitive data in version control.

## Local Development Setup

1. Copy the example configuration:
   ```bash
   cp assets/js/firebase-config.example.js assets/js/firebase-config-local.js
   ```

2. Edit `assets/js/firebase-config-local.js` with your Firebase project credentials:
   - Replace all placeholder values with actual Firebase project details
   - Get these values from your Firebase Console > Project Settings

3. The `firebase-config-local.js` file is automatically ignored by git and will not be committed.

## Production Setup (Netlify)

Set the following environment variables in your Netlify dashboard:

- `FIREBASE_API_KEY`
- `FIREBASE_AUTH_DOMAIN` 
- `FIREBASE_PROJECT_ID`
- `FIREBASE_STORAGE_BUCKET`
- `FIREBASE_MESSAGING_SENDER_ID`
- `FIREBASE_APP_ID`
- `FIREBASE_MEASUREMENT_ID`

The build process automatically generates `assets/js/firebase-config.js` from these environment variables.

## How It Works

- **Local**: Uses `firebase-config-local.js` (ignored by git)
- **Production**: Uses `firebase-config.js` (generated from env vars)
- The HTML loader tries local config first, falls back to production config
- Both config files are ignored by git for security

## Security Notes

- Never commit actual Firebase credentials to version control
- Both `firebase-config-local.js` and `firebase-config.js` are gitignored
- Only the example template is tracked in version control