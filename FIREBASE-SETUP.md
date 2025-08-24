# Firebase Authentication Setup

This project uses Firebase Authentication for user sign-in functionality. The authentication is optional - users can use the apps without signing in, but signing in enables data synchronization across devices.

## Environment Configuration

### Production (Netlify)
Set the following environment variables in your Netlify dashboard:
- `FIREBASE_API_KEY`
- `FIREBASE_AUTH_DOMAIN`
- `FIREBASE_PROJECT_ID`
- `FIREBASE_STORAGE_BUCKET`
- `FIREBASE_MESSAGING_SENDER_ID`
- `FIREBASE_APP_ID`
- `FIREBASE_MEASUREMENT_ID` (optional)

### Local Development

You have two options for local development:

#### Option 1: Using a Local Config File (Recommended)
1. Copy `assets/js/firebase-config-local.template.js` to `assets/js/firebase-config-local.js`
2. Fill in your Firebase project configuration values
3. The file is already in `.gitignore` and will not be committed

```bash
cp assets/js/firebase-config-local.template.js assets/js/firebase-config-local.js
# Edit the file with your Firebase config values
```

#### Option 2: Using Environment Variables
Set environment variables when running your local server:

```bash
FIREBASE_API_KEY=xxx \
FIREBASE_AUTH_DOMAIN=xxx \
FIREBASE_PROJECT_ID=xxx \
npm start
```

## How It Works

1. **firebase-config.js** - Checks for configuration in this order:
   - Environment variables (for production/Netlify)
   - Window.__env object (for Netlify edge functions)
   - Falls back to empty config

2. **firebase-config-local.js** - Loaded optionally for local development
   - If the file exists, it overrides the environment config
   - If it doesn't exist, a console message is shown but the app continues

3. **main.js** - Contains the Firebase initialization and auth UI
   - Automatically detects available configuration
   - Shows "Sign In" button only when Firebase is properly configured

## File Structure

```
assets/js/
├── firebase-config.js              # Main config loader (committed)
├── firebase-config-local.template.js # Template for local config (committed)
├── firebase-config-local.js        # Your local config (NOT committed)
└── main.js                         # Firebase initialization and auth UI
```

## Security Notes

- Never commit `firebase-config-local.js` to the repository
- Firebase API keys are safe to expose in frontend code (they're restricted by domain)
- Use Firebase Security Rules to protect your data
- Enable only the authentication methods you need in Firebase Console

## Testing

1. **Local Testing**: Create your `firebase-config-local.js` file and test locally
2. **Production Testing**: Deploy to Netlify with environment variables set
3. **Fallback Testing**: Delete/rename local config to test environment variable loading

## Troubleshooting

- **"Firebase SDK not available"**: Check that Firebase scripts are loading properly
- **"Firebase configuration not available"**: Ensure either local config or env vars are set
- **Auth button not showing**: Firebase might not be configured - check browser console
- **Sign in not working**: Verify Firebase project settings and enabled auth methods