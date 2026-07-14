// Netlify Function: reports.js
// Gera reports de treino personalizados (semanal / mensal / pos-prova) via Claude.
// Recebe dados REAIS de aderencia e volume; retorna texto plano (sem markdown).

// CLC item 3: valida o token de sessao do Supabase antes de gastar credito de API.
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

exports.handler = async (event) => {
  const HEADERS = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: HEADERS, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: HEADERS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const user = await verifyAuth(event);
  if (!user) {
    return { statusCode: 401, headers: HEADERS, body: JSON.stringify({ error: 'Nao autenticado.' }) };
  }

  const API_KEY = process.env.ANTHROPIC_API_KEY;
  if (!API_KEY) {
    return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ error: 'ANTHROPIC_API_KEY nao configurada' }) };
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (e) {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'JSON invalido' }) };
  }

  const type = body.type || 'weekly';
  const d = body.data || {};

  // Perfil basico
  const nome = (d.name || 'atleta').toString().slice(0, 40);
  const sport = d.sport || 'triathlon';
  const raceName = d.raceName || 'sua prova';
  const raceDist = d.raceDist || '';
  const daysToRace = d.daysToRace != null ? d.daysToRace : '';
  const phase = d.phase || '';

  // Monta a secao de dados conforme o tipo
  let contexto = '';
  let instrucao = '';

  if (type === 'weekly') {
    contexto = `Report SEMANAL. Semana ${d.week || '?'} de ${d.totalWeeks || '?'} (fase ${phase}).
Aderencia da semana: ${d.done || 0} de ${d.total || 0} sessoes concluidas (${d.pct || 0}%).
Volume por modalidade nesta semana: natacao ${d.swimKm || 0}km, bike ${d.bikeKm || 0}km, corrida ${d.runKm || 0}km.
Sessoes de forca/core concluidas: ${d.strengthDone || 0}.
Faltam ${daysToRace} dias para ${raceName}.`;
    instrucao = 'Escreva um report semanal de 3 a 4 frases. Reconheca o que foi bem, aponte 1 ponto de atencao e de 1 orientacao pratica para a proxima semana. Tom de treinador direto e motivador, sem exageros.';
  } else if (type === 'monthly') {
    contexto = `Report MENSAL. Ultimas ~4 semanas.
Aderencia geral do mes: ${d.done || 0} de ${d.total || 0} sessoes (${d.pct || 0}%).
Volume total do mes: natacao ${d.swimKm || 0}km, bike ${d.bikeKm || 0}km, corrida ${d.runKm || 0}km.
Evolucao de aderencia semana a semana: ${(d.weeklyTrend || []).join('%, ')}%.
Fase atual: ${phase}. Faltam ${daysToRace} dias para ${raceName}.`;
    instrucao = 'Escreva um report mensal de 4 a 5 frases. Avalie a consistencia e a tendencia de evolucao, destaque a modalidade mais forte e a que precisa de foco, e projete o que o proximo mes exige dada a proximidade da prova. Tom analitico de treinador.';
  } else if (type === 'race') {
    contexto = `Report POS-PROVA de ${raceName} (${raceDist}).
Meta do atleta: ${d.goalTime || 'nao definida'}. Tempo realizado: ${d.actualTime || 'nao informado'}.
Preparacao: completou ${d.done || 0} de ${d.total || 0} sessoes no ciclo (${d.pct || 0}%).
Observacoes do atleta: ${(d.notes || 'nenhuma').toString().slice(0, 300)}.`;
    instrucao = 'Escreva uma retrospectiva pos-prova de 4 a 6 frases. Celebre a conquista, relacione o resultado com a preparacao real, aponte 1 ou 2 aprendizados concretos e sugira o proximo foco. Tom de treinador que acompanhou a jornada.';
  } else {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'type invalido' }) };
  }

  const prompt = `Voce e o coach de IA do MyTri, app de treino para ${sport}. O atleta se chama ${nome}.

${contexto}

${instrucao}

Regras de formato:
- Responda em portugues do Brasil, texto corrido, sem markdown, sem bullet points, sem titulos.
- Nao use emojis.
- Fale diretamente com ${nome} (segunda pessoa).
- Seja especifico usando os numeros fornecidos. Nao invente dados que nao foram dados.`;

  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5',
        max_tokens: 600,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      return { statusCode: 502, headers: HEADERS, body: JSON.stringify({ error: 'Claude API erro', detail: errText.slice(0, 300) }) };
    }

    const data = await resp.json();
    const text = (data.content && data.content[0] && data.content[0].text) ? data.content[0].text.trim() : '';
    return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ text }) };
  } catch (e) {
    return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ error: e.message }) };
  }
};
