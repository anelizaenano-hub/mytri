const https = require('https');

exports.handler = async (event) => {
  const { lat, lon } = event.queryStringParameters || {};
  if (!lat || !lon) return { statusCode: 400, body: 'Missing lat/lon' };

  return new Promise((resolve) => {
    const path = `/reverse?lat=${lat}&lon=${lon}&format=json&accept-language=pt-BR&zoom=16&addressdetails=1`;
    const req = https.request({
      hostname: 'nominatim.openstreetmap.org',
      path,
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
          const a = d.address || {};
          // Tenta todos os campos possíveis de bairro no OSM Brasil
          const bairro = a.suburb || a.neighbourhood || a.quarter || a.city_district || a.district || a.borough || '';
          const cidade = a.city || a.town || a.municipality || a.county || '';
          const estado = a.state_code || (a.state ? a.state.replace('Estado de ','').replace('Estado do ','') : '') || '';
          let loc = '';
          if (bairro && cidade) loc = `${bairro}, ${cidade}`;
          else if (cidade && estado) loc = `${cidade} — ${estado}`;
          else loc = cidade || bairro || '';
          resolve({
            statusCode: 200,
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
            body: JSON.stringify({ loc, debug: { bairro, cidade, estado, raw: a } })
          });
        } catch(e) {
          resolve({ statusCode: 500, body: JSON.stringify({ loc: '', error: e.message }) });
        }
      });
    });
    req.on('error', (e) => resolve({ statusCode: 500, body: JSON.stringify({ loc: '', error: e.message }) }));
    req.end();
  });
};
