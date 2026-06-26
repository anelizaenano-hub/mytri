const https = require('https');

exports.handler = async (event) => {
  const { lat, lon } = event.queryStringParameters || {};
  if (!lat || !lon) return { statusCode: 400, body: 'Missing lat/lon' };

  const key = process.env.OPENCAGE_API_KEY || 'e5ec55ee94a349b0b58a5a13d6366adf';

  return new Promise((resolve) => {
    const path = `/geocode/v1/json?q=${lat}+${lon}&key=${key}&language=pt&no_annotations=1&limit=1`;
    const req = https.request({
      hostname: 'api.opencagedata.com',
      path,
      method: 'GET',
      headers: { 'User-Agent': 'MyTri-App/1.0' }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const d = JSON.parse(data);
          const comp = d.results?.[0]?.components || {};
          const bairro = comp.suburb || comp.neighbourhood || comp.quarter || comp.city_district || comp.district || '';
          const cidade = comp.city || comp.town || comp.municipality || '';
          const estado = comp.state_code || comp.state || '';
          let loc = '';
          if (bairro && cidade) loc = `${bairro}, ${cidade}`;
          else if (cidade && estado) loc = `${cidade} — ${estado}`;
          else loc = cidade || bairro || '';
          resolve({
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ loc })
          });
        } catch(e) {
          resolve({ statusCode: 500, body: JSON.stringify({ loc: '' }) });
        }
      });
    });
    req.on('error', () => resolve({ statusCode: 500, body: JSON.stringify({ loc: '' }) }));
    req.end();
  });
};
