const https = require('https');

// Busca provas REAIS via web search da API Anthropic.
// Recebe: { sport, raceDist, distLabel, location, state, monthsAhead, broaden }
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

// CLC item 3: valida o token de sessao do Supabase antes de gastar credito de API/busca.
const SUPABASE_URL = 'https://dlahyvsrqouxlalqexrp.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_mVgR-2qjgAGzEBeitJ8SAg_DTFYuw-t';
async function verifyAuth(event) {
  const auth = (event.headers && (event.headers.authorization || event.headers.Authorization)) || '';
  const token = auth.replace(/^Bearer\s+/i, '');
  if (!token) return null;
  try {
    const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` }
    });
    if (!r.ok) return null;
    const user = await r.json();
    return (user && user.id) ? user : null;
  } catch (e) { return null; }
}

// Memoria compartilhada de provas ja encontradas em buscas anteriores — torna a busca mais
// consistente, ja que a busca ao vivo por IA nao e 100% deterministica (pode achar uma prova
// numa tentativa e nao achar na proxima). Uma vez encontrada, a prova fica "grudada" pra
// sempre nas buscas futuras daquela regiao/modalidade.
async function fetchKnownRaces(state, sport) {
  try {
    const todayStr = new Date().toISOString().slice(0, 10);
    let url = `${SUPABASE_URL}/rest/v1/mytri_known_races?select=*&race_date=gte.${todayStr}&order=verified.desc,race_date.asc&limit=30`;
    if (sport) url += `&sport=eq.${encodeURIComponent(sport)}`;
    if (state) url += `&state=ilike.*${encodeURIComponent(state)}*`;
    const r = await fetch(url, { headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` } });
    if (!r.ok) return [];
    return await r.json();
  } catch (e) { return []; }
}
async function saveKnownRaces(races, sport, state) {
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SERVICE_KEY || !races.length) return;
  try {
    const rows = races.map(r => ({
      name: r.name, race_date: r.date, city: r.local, state: state || null,
      url: r.url || null, sport, distance: r.dist || null,
    }));
    await fetch(`${SUPABASE_URL}/rest/v1/mytri_known_races?on_conflict=name,race_date`, {
      method: 'POST',
      headers: {
        apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`,
        'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates',
      },
      body: JSON.stringify(rows),
    });
  } catch (e) { /* cache e um bonus, nao pode quebrar a busca principal se falhar */ }
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

  const user = await verifyAuth(event);
  if (!user) return { statusCode: 401, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ races: [], error: 'Nao autenticado.' }) };

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
  const state = body.state || '';
  const monthsAhead = body.monthsAhead || 8;
  const today = new Date().toISOString().slice(0, 10);
  const regionStr = state ? `${location} (estado: ${state})` : location;

  // Busca primeiro o que ja foi encontrado antes (memoria compartilhada) — isso roda em
  // paralelo com a preparacao da busca ao vivo, sem atrasar a resposta.
  const knownRacesPromise = fetchKnownRaces(state, sport);

  const prompt = `Busque na web provas REAIS e confirmadas de ${sportName}${distLabel ? ` na distância/categoria "${distLabel}"` : ''} que acontecerão a partir de hoje (${today}) nos próximos ${monthsAhead} meses.

O atleta está atualmente perto de "${regionStr}", mas NÃO necessariamente mora lá. Traga um panorama COMPLETO em 3 camadas, com cobertura MÍNIMA garantida em cada uma (não deixe uma camada dominar as outras):
1. REGIONAL — pelo menos 2 provas pequenas/médias perto de "${regionStr}", incluindo circuitos/assessorias esportivas com múltiplas etapas (ex: "Circuito X de Triathlon", "Etapa 2 — [assessoria]"). Raramente aparecem no calendário oficial da federação — busque termos como "circuito triathlon [estado]", "assessoria triathlon [cidade/regiao] calendário 2026".
2. NACIONAL — pelo menos 2-3 das principais provas de abrangência Brasil inteiro, incluindo o calendário oficial da federação (CBTri ou equivalente).
3. INTERNACIONAL — pelo menos 1-2 provas internacionais relevantes dessa modalidade/distância (majors, mundiais), SEMPRE que essa modalidade tiver provas internacionais conhecidas — não pule essa camada mesmo que as regionais pareçam suficientes.

CRÍTICO — onde provas pequenas/regionais realmente estão cadastradas: busque tambem nas plataformas brasileiras de inscrição: minhasinscricoes.com.br, ticketsports.com.br, sympla.com.br, corridaperfeita.com, ativo.com (ex: "site:minhasinscricoes.com.br triathlon [estado] 2026").

CRÍTICO — PRECISÃO DE DATA (a parte que mais importa): só inclua uma prova se você encontrou a data dela ESCRITA LITERALMENTE numa fonte pesquisada nesta busca. NUNCA estime, arredonde ou repita de memória a data de uma prova tradicional sem confirmar na busca atual — datas mudam de ano pra ano, e uma data "lembrada" de treinamento antigo é frequentemente ERRADA. Se encontrar a mesma prova em duas fontes com datas diferentes, faça mais uma busca pra desempatar antes de incluir. Se não conseguir confirmar a data exata de uma prova que você sabe que existe, é melhor OMITIR essa prova do resultado do que adivinhar.

Para cada prova, encontre: nome oficial (incluindo o nome da etapa/circuito se aplicável), data (formato AAAA-MM-DD, confirmada na fonte), cidade/país, e o link OFICIAL de inscrição — de preferência o link direto da pagina de inscricao na plataforma, nao so a home do site.

IMPORTANTE: faça ATE 6 buscas web diferentes, variando os termos (não repita a mesma busca) — distribua entre as 3 camadas acima, garantindo os mínimos de cada uma. Depois RESPONDA. Não continue buscando indefinidamente — é melhor responder com menos provas mas com data confirmada do que muitas provas com data chutada.

Sua ÚLTIMA mensagem deve conter APENAS um JSON válido (sem markdown, sem crases, sem texto antes ou depois) neste formato exato:
{"races":[{"name":"...","date":"AAAA-MM-DD","local":"Cidade, UF/País","url":"https://...","scope":"nacional"}]}

Regras:
- CRÍTICO: só inclua provas com data IGUAL OU POSTERIOR a ${today}. Nunca provas que já aconteceram.
- Retorne NO MÍNIMO 6 provas (idealmente 8 a 12), cobrindo regional/circuito + nacional + internacional. Provas regionais/de circuito pequenas contam pra esse total — não descarte por serem pequenas.
- Se souber que uma prova tradicional (grande ou de circuito local) acontece todo ano mas não achou a página de inscrição exata, inclua mesmo assim com o site oficial do evento/assessoria no campo url (ou url vazia).
- Ordene da mais próxima para a mais distante no tempo.
- "scope" deve ser "nacional" ou "internacional" (provas regionais/de circuito também usam "nacional").
- Só retorne {"races":[]} se realmente não existir nenhuma prova futura dessa modalidade.`;

  const requestBody = JSON.stringify({
    model: 'claude-haiku-4-5',
    max_tokens: 8000,
    messages: [{ role: 'user', content: prompt }],
    tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 6 }],
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

        // Mescla com a memoria de provas ja encontradas antes (mesmo nome+data nao duplica),
        // e salva as novas encontradas agora pra ficarem disponiveis nas proximas buscas —
        // e isso que torna a busca consistente ao longo do tempo, nao so na hora.
        knownRacesPromise.then(known => {
          const seen = new Set(races.map(r => `${r.name}|${r.date}`));
          const merged = [...races];
          for (const k of known) {
            const key = `${k.name}|${k.race_date}`;
            if (!seen.has(key)) {
              seen.add(key);
              merged.push({ name: k.name, date: k.race_date, local: k.city || '', url: k.url || '', dist: k.distance || '', sport, scope: 'nacional' });
            }
          }
          merged.sort((a, b) => a.date < b.date ? -1 : 1);
          saveKnownRaces(races, sport, state).catch(() => {});
          resolve({ statusCode: 200, headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(error ? { races: merged, error } : { races: merged }) });
        }).catch(() => {
          resolve({ statusCode: 200, headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(error ? { races, error } : { races }) });
        });
      });
    });
    req.on('error', (e) => resolve({ statusCode: 200, headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ races: [], error: 'Falha de rede ao chamar a API: ' + (e.message || 'desconhecida') }) }));
    req.write(requestBody);
    req.end();
  });
};
