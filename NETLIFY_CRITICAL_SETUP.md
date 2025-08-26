# CRITICAL: Netlify Firebase Setup - Quick Fix

## The Problem
Your Firebase config is returning empty values because environment variables are not accessible to Netlify Functions.

## The Solution (2 Steps)

### Step 1: Enable Functions Scope for Variables

1. Go to: **Netlify Dashboard** → **Site configuration** → **Environment variables**

2. For EACH Firebase variable, you MUST:
   - Click the **variable name** to edit it
   - In the **"Scopes"** section, check these boxes:
     - ✅ **Functions** (REQUIRED!)
     - ✅ **Builds** (optional but recommended)
     - ✅ **Post processing** (optional)
     - ✅ **Runtime** (if available)
   
3. The most common mistake is having only "Builds" checked. **Functions MUST be checked!**

### Step 2: Redeploy

After updating ALL 7 variables:
1. Go to **Deploys** tab
2. Click **"Trigger deploy"** → **"Deploy site"**
3. Wait 1-2 minutes for deployment

## Verification

1. Visit: `https://www.shevato.com/test-firebase-config.html`
2. Click "Test Environment Variables"
3. You should see "Found 7 Firebase variables"

## Alternative Method (If Scopes Don't Show)

If you don't see the Scopes option:

1. **Delete** all existing Firebase variables
2. **Re-add** them using this method:
   - Click **"Add a variable"** → **"Add a single variable"**
   - Enter the key and value
   - **Before saving**, look for **"Deploy contexts"** and **"Scopes"**
   - Make sure **"Functions"** is selected
   - Click **"Create variable"**

## Still Not Working?

Try using the Netlify CLI:
```bash
# Install Netlify CLI
npm install -g netlify-cli

# Login to Netlify
netlify login

# Link to your site
netlify link

# Set environment variables with function scope
netlify env:set FIREBASE_API_KEY "your-api-key" --scope functions
netlify env:set FIREBASE_AUTH_DOMAIN "your-auth-domain" --scope functions
netlify env:set FIREBASE_PROJECT_ID "your-project-id" --scope functions
netlify env:set FIREBASE_STORAGE_BUCKET "your-storage-bucket" --scope functions
netlify env:set FIREBASE_MESSAGING_SENDER_ID "your-sender-id" --scope functions
netlify env:set FIREBASE_APP_ID "your-app-id" --scope functions
netlify env:set FIREBASE_MEASUREMENT_ID "your-measurement-id" --scope functions
```

Then redeploy your site.