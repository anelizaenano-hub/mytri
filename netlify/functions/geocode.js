const https = require('https');

exports.handler = async (event) => {
  const { lat, lon } = event.queryStringParameters || {};
  if (!lat || !lon) return { statusCode: 400, body: 'Missing lat/lon' };

  return new Promise((resolve) => {
    const url = `/reverse?lat=${lat}&lon=${lon}&format=json&accept-language=pt-BR`;
    const req = https.request({
      hostname: 'nominatim.openstreetmap.org',
      path: url,
      method: 'GET',
      headers: {
        'User-Agent': 'MyTri-App/1.0 (nano-tri-v2.netlify.app)',
        'Accept': 'application/json'
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const d = JSON.parse(data);
          const suburb = d.address?.suburb || d.address?.neighbourhood || d.address?.quarter || d.address?.city_district || '';
          const city = d.address?.city || d.address?.town || d.address?.municipality || '';
          const state = d.address?.state || '';
          const loc = suburb && city ? `${suburb}, ${city}` : city && state ? `${city} — ${state}` : city || state || '';
          resolve({
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ loc })
          });
        } catch {
          resolve({ statusCode: 500, body: JSON.stringify({ loc: '' }) });
        }
      });
    });
    req.on('error', () => resolve({ statusCode: 500, body: JSON.stringify({ loc: '' }) }));
    req.end();
  });
};
