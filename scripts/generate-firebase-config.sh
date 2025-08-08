#!/bin/bash

# Generate Firebase configuration from environment variables
# This script runs at build time on Netlify

OUTPUT_FILE="assets/js/firebase-config.js"

# Create the JavaScript file with environment variables
cat > "$OUTPUT_FILE" << EOF
// Auto-generated Firebase configuration
// Generated at build time from environment variables
window.firebaseConfig = {
  apiKey: "${FIREBASE_API_KEY:-}",
  authDomain: "${FIREBASE_AUTH_DOMAIN:-}",
  projectId: "${FIREBASE_PROJECT_ID:-}",
  storageBucket: "${FIREBASE_STORAGE_BUCKET:-}",
  messagingSenderId: "${FIREBASE_MESSAGING_SENDER_ID:-}",
  appId: "${FIREBASE_APP_ID:-}",
  measurementId: "${FIREBASE_MEASUREMENT_ID:-}"
};
EOF

echo "✅ Firebase configuration generated at $OUTPUT_FILE"

# Show which variables were set (without showing values)
if [ -n "$FIREBASE_API_KEY" ]; then echo "  ✓ FIREBASE_API_KEY is set"; else echo "  ✗ FIREBASE_API_KEY is NOT set"; fi
if [ -n "$FIREBASE_AUTH_DOMAIN" ]; then echo "  ✓ FIREBASE_AUTH_DOMAIN is set"; else echo "  ✗ FIREBASE_AUTH_DOMAIN is NOT set"; fi
if [ -n "$FIREBASE_PROJECT_ID" ]; then echo "  ✓ FIREBASE_PROJECT_ID is set"; else echo "  ✗ FIREBASE_PROJECT_ID is NOT set"; fi
if [ -n "$FIREBASE_APP_ID" ]; then echo "  ✓ FIREBASE_APP_ID is set"; else echo "  ✗ FIREBASE_APP_ID is NOT set"; fi