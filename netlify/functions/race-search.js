const https = require('https');

// Busca provas REAIS via web search da API Anthropic.
// Recebe: { sport, raceDist, distLabel, location, monthsAhead }
// Retorna: { races: [ {name, date, local, url, dist, scope} ], note }
//
// Usa a ferramenta web_search para trazer datas e links de inscrição reais,
// evitando a fragilidade de uma lista estática que envelhece.

const SPORT_PT = {
  triathlon: 'triathlon',
  corrida: 'corrida de rua / running',
  ciclismo: 'ciclismo / prova de bike',
  natacao: 'natação / águas abertas',
  duathlon: 'duathlon',
};

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const sport = body.sport || 'triathlon';
  const sportName = SPORT_PT[sport] || sport;
  const distLabel = body.distLabel || body.raceDist || '';
  const location = body.location || 'Brasil';
  const monthsAhead = body.monthsAhead || 8;
  const today = new Date().toISOString().slice(0, 10);

  const prompt = `Busque na web provas REAIS e confirmadas de ${sportName}${distLabel ? ` na distância/categoria "${distLabel}"` : ''} que acontecerão a partir de hoje (${today}) nos próximos ${monthsAhead} meses.

Priorize provas próximas de "${location}" (nacionais no Brasil), mas inclua também as principais provas INTERNACIONAIS relevantes dessa modalidade e distância.

Para cada prova, encontre: nome oficial, data (formato AAAA-MM-DD), cidade/país, e o link OFICIAL de inscrição.

Responda APENAS com um JSON válido (sem markdown, sem crases, sem texto antes ou depois) neste formato exato:
{"races":[{"name":"...","date":"AAAA-MM-DD","local":"Cidade, UF/País","url":"https://...","scope":"nacional"}]}

Regras:
- Máximo 12 provas, ordenadas da mais próxima para a mais distante no tempo.
- Só inclua provas cuja data e link você conseguiu confirmar na busca. Se não confirmou, não invente.
- "scope" deve ser "nacional" ou "internacional".
- Se não achar nenhuma prova confiável, retorne {"races":[]}.`;

  const requestBody = JSON.stringify({
    model: 'claude-haiku-4-5',
    max_tokens: 1500,
    messages: [{ role: 'user', content: prompt }],
    tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }],
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
        'Content-Length': Buffer.byteLength(requestBody),
      },
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          // Concatena todos os blocos de texto da resposta (web search intercala blocos)
          const text = (parsed.content || [])
            .filter(b => b.type === 'text')
            .map(b => b.text)
            .join('\n');
          // Extrai o JSON da resposta (tolera texto/markdown ao redor)
          let races = [];
          const match = text.match(/\{[\s\S]*"races"[\s\S]*\}/);
          if (match) {
            try {
              const obj = JSON.parse(match[0]);
              if (Array.isArray(obj.races)) races = obj.races;
            } catch (e) { /* fallback abaixo */ }
          }
          // sanitizar: manter só campos esperados e datas plausíveis
          races = races
            .filter(r => r && r.name && r.date && /^\d{4}-\d{2}-\d{2}$/.test(r.date))
            .slice(0, 12)
            .map(r => ({
              name: String(r.name).slice(0, 120),
              date: r.date,
              local: String(r.local || '').slice(0, 80),
              url: /^https?:\/\//.test(r.url || '') ? r.url : '',
              dist: body.raceDist || '',
              sport,
              scope: r.scope === 'internacional' ? 'internacional' : 'nacional',
            }));
          resolve({ statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ races }) });
        } catch (e) {
          resolve({ statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ races: [], error: 'parse' }) });
        }
      });
    });
    req.on('error', () => resolve({ statusCode: 200, body: JSON.stringify({ races: [], error: 'network' }) }));
    req.write(requestBody);
    req.end();
  });
};
