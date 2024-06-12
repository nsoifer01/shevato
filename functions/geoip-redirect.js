const fetch = require('node-fetch');

exports.handler = async (event, context) => {
  const ip = event.headers['x-nf-client-connection-ip'];
  const ipstackApiKey = 'YOUR_IPSTACK_API_KEY'; // Replace with your ipstack API key
  const url = `http://api.ipstack.com/${ip}?access_key=${ipstackApiKey}`;

  try {
    const response = await fetch(url);
    const data = await response.json();
    
    if (data.country_code === 'IL') {
      return {
        statusCode: 302,
        headers: {
          Location: 'https://www.shevato.com/moadon-alef',
        },
      };
    } else {
      return {
        statusCode: 200,
        body: 'Access granted',
      };
    }
  } catch (error) {
    return {
      statusCode: 500,
      body: 'Internal Server Error',
    };
  }
};
