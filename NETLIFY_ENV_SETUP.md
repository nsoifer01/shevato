# Netlify Environment Variables Setup for Firebase Authentication

## Overview
Your Firebase authentication is already configured to work securely on production using environment variables. The system loads Firebase credentials from a Netlify Function that reads environment variables, keeping your API keys secure.

## How It Works

1. **Local Development**: Reads from `assets/js/firebase-config-local.js` (gitignored)
2. **Production (Netlify)**: Loads config from `/.netlify/functions/firebase-config` which reads environment variables

## Setting Up Environment Variables on Netlify

### Step 1: Access Netlify Site Settings
1. Log in to your Netlify account
2. Navigate to your site dashboard (shevato site)
3. Go to **Site configuration** > **Environment variables**

### Step 2: Add Firebase Environment Variables

**IMPORTANT**: Make sure to add these as **Site environment variables**, not build environment variables.

Add the following environment variables with your Firebase credentials:

| Key | Value |
|-----|-------|
| `FIREBASE_API_KEY` | `[Your Firebase API Key]` |
| `FIREBASE_AUTH_DOMAIN` | `[Your Firebase Auth Domain]` |
| `FIREBASE_PROJECT_ID` | `[Your Firebase Project ID]` |
| `FIREBASE_STORAGE_BUCKET` | `[Your Firebase Storage Bucket]` |
| `FIREBASE_MESSAGING_SENDER_ID` | `[Your Firebase Messaging Sender ID]` |
| `FIREBASE_APP_ID` | `[Your Firebase App ID]` |
| `FIREBASE_MEASUREMENT_ID` | `[Your Firebase Measurement ID]` |

### Step 3: Configure Environment Variable Settings
For each variable:
1. **Key**: Enter the exact variable name from the table above (case-sensitive)
2. **Values**: 
   - Select **"Same value for all deploy contexts"**
   - Enter the corresponding value (without quotes)
3. **Scopes**: Make sure **"Functions"** is checked (this is crucial!)
4. Click **"Create variable"**

### Step 4: Verify Variables Are Set
After adding all variables:
1. You should see all 7 variables listed
2. Each should show "Functions" in the Scopes column
3. Double-check there are no typos in the variable names

### Step 5: Deploy Your Site
After adding all environment variables:
1. **IMPORTANT**: You must trigger a new deploy for the changes to take effect
2. Either:
   - Push a new commit to trigger automatic deploy
   - Or go to **Deploys** tab and click **"Trigger deploy" > "Deploy site"**
3. Wait for the deploy to complete (usually 1-2 minutes)
4. Visit your production site and test the authentication

## Verification

### Check if Config is Loading
1. Open your production site
2. Open browser developer console (F12)
3. Look for these messages:
   - "Production environment detected. Loading config from Netlify Function..."
   - "Firebase config loaded successfully from Netlify Function"
   - "Firebase Authentication initialized successfully"

### Test Authentication
1. Try signing up with a test account
2. Try signing in
3. Check if the authentication modal works properly

## Troubleshooting

### Common Issue: Environment Variables Return Empty

If you see empty values in the console like:
```javascript
window.firebaseConfig = {
  "apiKey": "",
  "authDomain": "",
  ...
}
```

**Solution:**
1. **Check Variable Scopes**: In Netlify dashboard > Environment variables:
   - Each variable MUST have **"Functions"** scope enabled
   - If not visible, edit each variable and check the "Functions" checkbox
   
2. **Redeploy After Changes**:
   - Environment variable changes require a new deploy
   - Go to Deploys tab > "Trigger deploy" > "Deploy site"
   
3. **Check Netlify Function Logs**:
   - Go to Functions tab in Netlify dashboard
   - Click on `firebase-config` function
   - Check the logs for any error messages

### If Authentication Still Isn't Working:

1. **Verify Environment Variables**
   - In Netlify dashboard, check that all 7 environment variables are set
   - **Critical**: Each must have "Functions" in the Scopes column
   - Make sure there are no typos in variable names
   - Ensure values don't have extra quotes or spaces

2. **Check Netlify Function**
   - In Netlify dashboard, go to **Functions** tab
   - Look for `firebase-config` function
   - It should show invocations when you load the site
   - Click to view logs and check for errors

3. **Check Browser Console**
   - Look for any error messages
   - Check Network tab for the request to `/.netlify/functions/firebase-config`
   - Should return 200 status with JavaScript code containing your config

4. **Clear Cache**
   - Try hard refresh (Ctrl+Shift+R or Cmd+Shift+R)
   - Clear browser cache and cookies for your site
   - Try in an incognito/private window

## Security Notes

- Never commit `firebase-config-local.js` to Git (it's already in .gitignore)
- Environment variables are only accessible server-side through Netlify Functions
- The API key is safe to expose in frontend as Firebase uses domain restrictions
- For additional security, configure domain restrictions in Firebase Console:
  1. Go to Firebase Console
  2. Project Settings > General
  3. Add your production domain to "Authorized domains"

## Local Development

For local development, make sure you have `assets/js/firebase-config-local.js` with your config:

```javascript
window.firebaseConfig = {
  apiKey: "[Your Firebase API Key]",
  authDomain: "[Your Firebase Auth Domain]",
  projectId: "[Your Firebase Project ID]",
  storageBucket: "[Your Firebase Storage Bucket]",
  messagingSenderId: "[Your Firebase Messaging Sender ID]",
  appId: "[Your Firebase App ID]",
  measurementId: "[Your Firebase Measurement ID]"
};
```

This file is gitignored and won't be committed to your repository.

You can get these values from:
1. Firebase Console → Your Project → Project Settings → General
2. Scroll down to "Your apps" section
3. Find your web app and view the configuration

## Support

If you continue to have issues:
1. Check Netlify Function logs in the Functions tab
2. Verify Firebase project settings
3. Ensure your Firebase project is active and not suspended