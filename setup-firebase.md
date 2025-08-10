# Firebase Authentication Setup

This guide will help you set up Firebase Authentication for the Shevato website.

## Step 1: Create a Firebase Project

1. Go to the [Firebase Console](https://console.firebase.google.com/)
2. Click "Create a project" or "Add project"
3. Enter a project name (e.g., "shevato-auth")
4. Enable Google Analytics if desired (optional)
5. Click "Create project"

## Step 2: Enable Authentication

1. In your Firebase project, click "Authentication" in the left sidebar
2. Click "Get started"
3. Go to the "Sign-in method" tab
4. Enable the following providers:
   - **Email/Password**: Click on it, toggle "Enable", then "Save"
   - **Google**: Click on it, toggle "Enable", add your project email in "Support email", then "Save"

## Step 3: Get Your Configuration

1. Click on the gear icon (Project Settings) in the left sidebar
2. Scroll down to "Your apps" section
3. Click on the web icon (`</>`) to add a web app
4. Give it a name (e.g., "Shevato Website")
5. Don't check "Set up Firebase Hosting" for now
6. Click "Register app"
7. Copy the config object that looks like this:

```javascript
const firebaseConfig = {
  apiKey: "your_api_key_here",
  authDomain: "your_project_id.firebaseapp.com", 
  projectId: "your_project_id",
  storageBucket: "your_project_id.appspot.com",
  messagingSenderId: "123456789",
  appId: "1:123456789:web:abcdef123456",
  measurementId: "G-ABCDEF1234"
};
```

## Step 4: Configure Environment Variables

### For Local Development:
1. Copy `.env.example` to `.env`:
   ```bash
   cp .env.example .env
   ```
2. Edit `.env` and replace the placeholder values with your actual Firebase config values

### For Netlify Deployment:
1. Go to your Netlify site dashboard
2. Click "Site settings" → "Environment variables"
3. Add each of the following variables with your Firebase config values:
   - `VITE_FIREBASE_API_KEY`
   - `VITE_FIREBASE_AUTH_DOMAIN`  
   - `VITE_FIREBASE_PROJECT_ID`
   - `VITE_FIREBASE_STORAGE_BUCKET`
   - `VITE_FIREBASE_MESSAGING_SENDER_ID`
   - `VITE_FIREBASE_APP_ID`
   - `VITE_FIREBASE_MEASUREMENT_ID`

## Step 5: Configure Domain Authorization

1. In Firebase Console, go to "Authentication" → "Settings" → "Authorized domains"
2. Add your domains:
   - `localhost` (for local development)
   - Your Netlify domain (e.g., `your-site.netlify.app`)
   - Your custom domain if you have one (e.g., `shevato.com`)

## Step 6: Test the Integration

1. Open your website
2. You should see a "Sign In" button in the header
3. Click it to test the authentication flow
4. Try both email/password signup and Google sign-in

## Troubleshooting

### If authentication doesn't work:
1. Check browser console for errors
2. Verify all environment variables are set correctly
3. Make sure your domain is in the authorized domains list
4. Ensure Authentication providers are enabled in Firebase Console

### If the UI doesn't appear:
1. Check that Firebase scripts are loading (no 404 errors in Network tab)
2. Verify the CSS files are loading correctly
3. Check browser console for JavaScript errors

## Security Notes

- Never commit your `.env` file to git
- The `.env.example` file is safe to commit as it contains no real credentials
- Environment variables in Netlify are secure and not exposed to the public
- Firebase automatically handles secure token management