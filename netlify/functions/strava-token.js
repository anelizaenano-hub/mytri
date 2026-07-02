const https = require('https');

// Proxy seguro para o token exchange do Strava.
// Mantém STRAVA_CLIENT_SECRET como variável de ambiente no Netlify — nunca exposto no client.
// Aceita dois modos:
//   { grant_type:'authorization_code', code:'...' }
//   { grant_type:'refresh_token', refresh_token:'...' }

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const clientId = process.env.STRAVA_CLIENT_ID || '257886';
  const clientSecret = process.env.STRAVA_CLIENT_SECRET;
  if (!clientSecret) return { statusCode: 500, body: JSON.stringify({ error: 'STRAVA_CLIENT_SECRET nao configurado' }) };

  const grant = body.grant_type;
  const payload = { client_id: clientId, client_secret: clientSecret, grant_type: grant };

  if (grant === 'authorization_code') {
    if (!body.code) return { statusCode: 400, body: JSON.stringify({ error: 'code ausente' }) };
    payload.code = body.code;
  } else if (grant === 'refresh_token') {
    if (!body.refresh_token) return { statusCode: 400, body: JSON.stringify({ error: 'refresh_token ausente' }) };
    payload.refresh_token = body.refresh_token;
  } else {
    return { statusCode: 400, body: JSON.stringify({ error: 'grant_type invalido' }) };
  }

  const requestBody = JSON.stringify(payload);

  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'www.strava.com',
      path: '/oauth/token',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(requestBody)
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        // Repassa o corpo do Strava como veio (contém access_token/refresh_token/expires_at/athlete)
        resolve({
          statusCode: res.statusCode || 200,
          headers: { 'Content-Type': 'application/json' },
          body: data
        });
      });
    });
    req.on('error', () => resolve({ statusCode: 502, body: JSON.stringify({ error: 'Falha ao contatar Strava' }) }));
    req.write(requestBody);
    req.end();
  });
};
