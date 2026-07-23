// BACKGROUND FUNCTION — mesmo formato classico (exports.handler + sufixo -background) que ja
// resolveu plan-summary e bike-fit. A busca de provas e a mais pesada das tres (ate 6 buscas web
// + a IA), entao era a que mais sofria com o teto de tempo sincrono. A logica de "se vier vazio,
// tenta de novo mais amplo" que antes vivia no cliente (2 chamadas sequenciais) foi movida pra
// dentro dessa function — o cliente agora so dispara uma vez e fica consultando o status.

const SUPABASE_URL = 'https://dlahyvsrqouxlalqexrp.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_mVgR-2qjgAGzEBeitJ8SAg_DTFYuw-t';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const SPORT_PT = {
  triathlon: 'triathlon',
  corrida: 'corrida de rua / running',
  ciclismo: 'ciclismo / prova de bike',
  natacao: 'natação / águas abertas',
  duathlon: 'duathlon',
};

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

async function upsertResult(userId, fields) {
  if (!SUPABASE_SERVICE_ROLE_KEY) { console.log('[race-search-bg] SUPABASE_SERVICE_ROLE_KEY nao configurada.'); return; }
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/mytri_race_searches?on_conflict=user_id`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates,return=minimal'
      },
      body: JSON.stringify({ user_id: userId, updated_at: new Date().toISOString(), ...fields })
    });
  } catch (e) { console.log('[race-search-bg] falha ao gravar resultado:', e.message); }
}

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
  if (!SUPABASE_SERVICE_ROLE_KEY || !races.length) return;
  try {
    const rows = races.map(r => ({
      name: r.name, race_date: r.date, city: r.local, state: state || null,
      url: r.url || null, sport, distance: r.dist || null,
    }));
    await fetch(`${SUPABASE_URL}/rest/v1/mytri_known_races?on_conflict=name,race_date`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates',
      },
      body: JSON.stringify(rows),
    });
  } catch (e) { /* cache e um bonus, nao pode quebrar a busca principal se falhar */ }
}

function buildPrompt({ sportName, distLabel, regionStr, today, monthsAhead }) {
  return `Busque na web provas REAIS e confirmadas de ${sportName}${distLabel ? ` na distância/categoria "${distLabel}"` : ''} que acontecerão a partir de hoje (${today}) nos próximos ${monthsAhead} meses.

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
}

async function runSearch({ sport, sportName, distLabel, regionStr, today, monthsAhead }) {
  const prompt = buildPrompt({ sportName, distLabel, regionStr, today, monthsAhead });
  const requestBody = JSON.stringify({
    model: 'claude-haiku-4-5',
    max_tokens: 8000,
    messages: [{ role: 'user', content: prompt }],
    tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 6 }],
  });
  const _t0 = Date.now();
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: requestBody
  });
  const data = await response.json();
  console.log(`[race-search-bg] chamada levou ${Date.now() - _t0}ms, HTTP ${response.status}`);
  if (!response.ok) return { races: [], error: data.error?.message || `HTTP ${response.status}` };

  const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
  const stopReason = data.stop_reason || '';
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
      dist: '', sport,
      scope: r.scope === 'internacional' ? 'internacional' : 'nacional',
    }));

  let error = null;
  if (races.length === 0) {
    if (!obj && stopReason === 'max_tokens') error = 'A busca foi longa demais e a resposta foi cortada.';
    else if (!obj) error = 'Nao consegui extrair a lista de provas da resposta.';
  }
  return { races, error };
}

exports.handler = async (event) => {
  console.log('[race-search-bg] invocada.');
  const user = await verifyAuth(event);
  if (!user) { console.log('[race-search-bg] sem autenticacao, abortando.'); return { statusCode: 202, body: '' }; }

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { console.log('[race-search-bg] corpo invalido.'); return { statusCode: 202, body: '' }; }

  await upsertResult(user.id, { status: 'pending', races_json: null, error_message: null });

  if (!process.env.ANTHROPIC_API_KEY) {
    await upsertResult(user.id, { status: 'error', error_message: 'ANTHROPIC_API_KEY nao configurada.' });
    return { statusCode: 202, body: '' };
  }

  const sport = body.sport || 'triathlon';
  const sportName = SPORT_PT[sport] || sport;
  const distLabel = body.distLabel || body.raceDist || '';
  const location = body.location || 'Brasil';
  const state = body.state || '';
  const today = new Date().toISOString().slice(0, 10);
  const regionStr = state ? `${location} (estado: ${state})` : location;

  const knownRacesPromise = fetchKnownRaces(state, sport);

  try {
    // Primeira tentativa: regiao/prazo normais.
    let { races, error } = await runSearch({ sport, sportName, distLabel, regionStr, today, monthsAhead: body.monthsAhead || 8 });

    // Se veio vazio, tenta de novo mais amplo (Brasil inteiro, janela maior) — antes isso era
    // uma 2a chamada feita pelo cliente, agora fica tudo dentro dessa mesma execucao em background.
    if (races.length === 0) {
      console.log('[race-search-bg] 1a tentativa vazia, tentando mais amplo.');
      const retry = await runSearch({ sport, sportName, distLabel, regionStr: 'Brasil', today, monthsAhead: 14 });
      races = retry.races;
      error = races.length > 0 ? null : (retry.error || error);
    }

    const known = await knownRacesPromise;
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

    await upsertResult(user.id, { status: 'done', races_json: JSON.stringify(merged), error_message: error || null });
    console.log(`[race-search-bg] concluido, ${merged.length} provas.`);
  } catch (e) {
    console.log('[race-search-bg] excecao:', e.message);
    await upsertResult(user.id, { status: 'error', error_message: e.message });
  }
  return { statusCode: 202, body: '' };
};
