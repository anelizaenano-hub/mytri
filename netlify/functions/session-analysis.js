const https = require('https');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, body: 'Invalid JSON' };
  }

  const { session, strava, profile, daysToRace, week, phase } = body;

  const typeNames = {
    swim: 'Natacao', bike: 'Bike', run: 'Corrida',
    gym: 'Musculacao', brick: 'Tijolo', tennis: 'Tenis', rest: 'Descanso'
  };

  const typeName = typeNames[session?.type] || session?.type || 'Treino';

  const prompt = `Voce e o coach pessoal de ${profile?.name || 'Nano Garcia'}, 41 anos, 62kg, preparando para Sprint Triathlon em ${daysToRace} dias (750m nado / 20km bike / 5km corrida). Fraqueza principal: natacao em aguas abertas. Fase atual do plano: ${phase || 'Base'} (semana ${week || '?'} de 16).

O atleta acabou de completar um treino de ${typeName} com os seguintes dados do Garmin/Strava:
${strava}

Sessao planejada: ${session?.text || typeName}${session?.dist ? ' - ' + session.dist : ''}

Escreva uma analise curta e motivacional desse treino especifico. Seja direto, objetivo e personalizado. Maximo 3 paragrafos curtos. Sem markdown, sem emojis, sem asteriscos, sem titulos. Texto corrido. Fale sobre o desempenho real (use os numeros), o que foi bom, e uma dica concreta para a proxima sessao similar. Leve em conta a lesao recuperada no iliotibial direito e a preparacao para o triathlon.`;

  const requestBody = JSON.stringify({
    model: 'claude-haiku-4-5',
    max_tokens: 400,
    messages: [{ role: 'user', content: prompt }]
  });

  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(requestBody)
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          const text = parsed?.content?.[0]?.text || '';
          resolve({
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text })
          });
        } catch {
          resolve({ statusCode: 500, body: JSON.stringify({ text: '' }) });
        }
      });
    });
    req.on('error', () => resolve({ statusCode: 500, body: JSON.stringify({ text: '' }) }));
    req.write(requestBody);
    req.end();
  });
};
