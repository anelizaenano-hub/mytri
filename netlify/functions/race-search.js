const https = require('https');

// Busca provas REAIS via web search da API Anthropic.
// Recebe: { sport, raceDist, distLabel, location, monthsAhead, broaden }
// Retorna: { races: [ {name, date, local, url, dist, scope} ], note?, error? }

const SPORT_PT = {
  triathlon: 'triathlon',
  corrida: 'corrida de rua / running',
  ciclismo: 'ciclismo / prova de bike',
  natacao: 'natação / águas abertas',
  duathlon: 'duathlon',
};

// Extrai o objeto JSON que contem a chave "races" de um texto que pode ter
// markdown/prosa/varios blocos ao redor. Balanceamento de chaves a partir da
// "{" ANTES de "races" (o regex ganancioso antigo pegava do 1o "{" e quebrava).
function extractRacesJson(text) {
  if (!text) return null;
  const key = text.indexOf('"races"');
  if (key === -1) return null;
  let start = text.lastIndexOf('{', key);
  if (start === -1) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(text.slice(start, i + 1)); } catch (e) { return null; }
      }
    }
  }
  return null;
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

  if (!process.env.ANTHROPIC_API_KEY) {
    return { statusCode: 200, headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ races: [], error: 'ANTHROPIC_API_KEY nao configurada na Netlify (Site settings > Environment variables).' }) };
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const sport = body.sport || 'triathlon';
  const sportName = SPORT_PT[sport] || sport;
  const distLabel = body.distLabel || body.raceDist || '';
  const location = body.location || 'Brasil';
  const monthsAhead = body.monthsAhead || 8;
  const today = new Date().toISOString().slice(0, 10);

  const prompt = `Busque na web provas REAIS e confirmadas de ${sportName}${distLabel ? ` na distância/categoria "${distLabel}"` : ''} que acontecerão a partir de hoje (${today}) nos próximos ${monthsAhead} meses.

O atleta está atualmente perto de "${location}", mas NÃO necessariamente mora lá. Traga um panorama COMPLETO em camadas, nesta ordem de prioridade:
1. Algumas provas próximas de "${location}" e da mesma região/estado (se existirem).
2. As principais provas NACIONAIS (Brasil inteiro) dessa modalidade e distância.
3. As principais provas INTERNACIONAIS relevantes dessa modalidade e distância (majors, mundiais, etc).

Não limite a busca só à cidade atual do atleta — a maioria das opções deve ser nacional e internacional.

Para cada prova, encontre: nome oficial, data (formato AAAA-MM-DD), cidade/país, e o link OFICIAL de inscrição.

IMPORTANTE: faça no máximo 3 ou 4 buscas web e depois RESPONDA. Não continue buscando indefinidamente — é melhor responder com as provas que já encontrou do que estourar o tempo.

Sua ÚLTIMA mensagem deve conter APENAS um JSON válido (sem markdown, sem crases, sem texto antes ou depois) neste formato exato:
{"races":[{"name":"...","date":"AAAA-MM-DD","local":"Cidade, UF/País","url":"https://...","scope":"nacional"}]}

Regras:
- CRÍTICO: só inclua provas com data IGUAL OU POSTERIOR a ${today}. Nunca provas que já aconteceram.
- Retorne NO MÍNIMO 6 provas (idealmente 8 a 12), cobrindo local + nacional + internacional.
- Se souber que uma prova tradicional acontece todo ano mas não achou a página de inscrição, inclua mesmo assim com o site oficial do evento no campo url (ou url vazia).
- Ordene da mais próxima para a mais distante no tempo.
- "scope" deve ser "nacional" ou "internacional".
- Só retorne {"races":[]} se realmente não existir nenhuma prova futura dessa modalidade.`;

  const requestBody = JSON.stringify({
    model: 'claude-haiku-4-5',
    max_tokens: 8000,
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
        let parsed;
        try { parsed = JSON.parse(data); }
        catch (e) {
          return resolve({ statusCode: 200, headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ races: [], error: 'Resposta invalida da API (HTTP ' + res.statusCode + ').' }) });
        }

        // Repassa erro real da API (creditos, modelo, ferramenta, rate limit) em vez de esconder.
        if (parsed.type === 'error' || parsed.error) {
          const msg = (parsed.error && (parsed.error.message || parsed.error.type)) || 'erro desconhecido da API';
          return resolve({ statusCode: 200, headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ races: [], error: 'API Anthropic (HTTP ' + res.statusCode + '): ' + msg }) });
        }
        if (res.statusCode !== 200) {
          return resolve({ statusCode: 200, headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ races: [], error: 'API retornou HTTP ' + res.statusCode + '.' }) });
        }

        const text = (parsed.content || [])
          .filter(b => b.type === 'text')
          .map(b => b.text)
          .join('\n');
        const stopReason = parsed.stop_reason || '';

        const obj = extractRacesJson(text);
        let races = (obj && Array.isArray(obj.races)) ? obj.races : [];

        const todayStr = new Date().toISOString().slice(0, 10);
        races = races
          .filter(r => r && r.name && r.date && /^\d{4}-\d{2}-\d{2}$/.test(r.date))
          .filter(r => r.date >= todayStr)
          .sort((a, b) => a.date < b.date ? -1 : 1)
          .slice(0, 15)
          .map(r => ({
            name: String(r.name).slice(0, 120),
            date: r.date,
            local: String(r.local || '').slice(0, 80),
            url: /^https?:\/\//.test(r.url || '') ? r.url : '',
            dist: body.raceDist || '',
            sport,
            scope: r.scope === 'internacional' ? 'internacional' : 'nacional',
          }));

        let error = null;
        if (races.length === 0) {
          if (!obj && stopReason === 'max_tokens') error = 'A busca foi longa demais e a resposta foi cortada. Tente de novo.';
          else if (!obj) error = 'Nao consegui extrair a lista de provas da resposta. Tente buscar de novo.';
        }

        resolve({ statusCode: 200, headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(error ? { races, error } : { races }) });
      });
    });
    req.on('error', (e) => resolve({ statusCode: 200, headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ races: [], error: 'Falha de rede ao chamar a API: ' + (e.message || 'desconhecida') }) }));
    req.write(requestBody);
    req.end();
  });
};
