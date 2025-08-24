/**
 * Netlify Function to serve Firebase configuration
 * This reads from environment variables and returns the config
 */

exports.handler = async (event, context) => {
  // Only allow GET requests
  if (event.httpMethod !== 'GET') {
    return {
      statusCode: 405,
      body: 'Method Not Allowed'
    };
  }

  // Build config from environment variables
  const config = {
    apiKey: process.env.FIREBASE_API_KEY || '',
    authDomain: process.env.FIREBASE_AUTH_DOMAIN || '',
    projectId: process.env.FIREBASE_PROJECT_ID || '',
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET || '',
    messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID || '',
    appId: process.env.FIREBASE_APP_ID || '',
    measurementId: process.env.FIREBASE_MEASUREMENT_ID || ''
  };

  // Debug: Log which environment variables are available (without exposing values)
  console.log('Environment variables status:', {
    FIREBASE_API_KEY: !!process.env.FIREBASE_API_KEY,
    FIREBASE_AUTH_DOMAIN: !!process.env.FIREBASE_AUTH_DOMAIN,
    FIREBASE_PROJECT_ID: !!process.env.FIREBASE_PROJECT_ID,
    FIREBASE_STORAGE_BUCKET: !!process.env.FIREBASE_STORAGE_BUCKET,
    FIREBASE_MESSAGING_SENDER_ID: !!process.env.FIREBASE_MESSAGING_SENDER_ID,
    FIREBASE_APP_ID: !!process.env.FIREBASE_APP_ID,
    FIREBASE_MEASUREMENT_ID: !!process.env.FIREBASE_MEASUREMENT_ID
  });

  // Return as JavaScript that sets window.firebaseConfig
  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'application/javascript',
      'Cache-Control': 'public, max-age=3600'
    },
    body: `window.firebaseConfig = ${JSON.stringify(config, null, 2)};`
  };
};