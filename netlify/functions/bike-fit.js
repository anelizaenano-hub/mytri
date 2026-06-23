const https = require('https');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_API_KEY) {
    return { statusCode: 500, body: JSON.stringify({ error: 'API key not configured' }) };
  }

  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { prompt, imageBase64 } = body;

  if (!prompt) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Missing prompt' }) };
  }

  const content = imageBase64
    ? [
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: imageBase64 } },
        { type: 'text', text: prompt }
      ]
    : [{ type: 'text', text: prompt }];

  const payload = Buffer.from(JSON.stringify({
    model: 'claude-sonnet-4-6',
    max_tokens: 1500,
    messages: [{ role: 'user', content }]
  }), 'utf8');

  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'x-api-key': ANTHROPIC_API_KEY.trim(),
        'anthropic-version': '2023-06-01',
        'Content-Length': payload.length
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode !== 200) {
            resolve({ statusCode: res.statusCode, body: JSON.stringify({ error: parsed.error?.message || data }) });
          } else {
            const text = parsed.content?.map(b => b.text || '').join('') || '';
            resolve({
              statusCode: 200,
              headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
              body: JSON.stringify({ text })
            });
          }
        } catch(e) {
          resolve({ statusCode: 500, body: JSON.stringify({ error: e.message, raw: data }) });
        }
      });
    });

    req.on('error', (e) => {
      resolve({ statusCode: 500, body: JSON.stringify({ error: e.message }) });
    });

    req.write(payload);
    req.end();
  });
};
