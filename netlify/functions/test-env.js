/**
 * Test function to verify environment variables are accessible
 */

exports.handler = async (event, context) => {
  // Get all env vars that start with FIREBASE_
  const firebaseVars = {};
  const allEnvVars = [];
  
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith('FIREBASE_')) {
      // Show first 3 chars of value for debugging (safe for API keys)
      firebaseVars[key] = value ? `${value.substring(0, 3)}...(length: ${value.length})` : 'EMPTY';
    }
    // List all env var names (not values)
    allEnvVars.push(key);
  }
  
  const diagnostic = {
    timestamp: new Date().toISOString(),
    firebaseVarsFound: Object.keys(firebaseVars).length,
    firebaseVars: firebaseVars,
    totalEnvVars: allEnvVars.length,
    netlifyContext: context.clientContext || 'none',
    // Check common Netlify env vars
    hasNetlifyEnv: !!process.env.NETLIFY,
    deployContext: process.env.CONTEXT || 'none',
    // List first 20 env var names to see what's available
    sampleEnvVarNames: allEnvVars.slice(0, 20)
  };
  
  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-cache'
    },
    body: JSON.stringify(diagnostic, null, 2)
  };
};