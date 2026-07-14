// Netlify Function: consult.js
// Consultoria Live: chat com Claude que conhece o perfil, plano, fase e evolucao do atleta.
// Recebe {messages:[...], profile:{...}} e retorna a resposta do coach.

// CLC item 3: valida o token de sessao do Supabase antes de gastar credito de API — sem isso,
// qualquer pessoa que descobrisse essa URL conseguia conversar com a IA sem estar logada.
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

  const p = body.profile || {};
  const messages = Array.isArray(body.messages) ? body.messages : [];
  if (!messages.length) {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'sem mensagens' }) };
  }

  // Sanitizar historico (so role/content, limita tamanho)
  const cleanMessages = messages
    .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .slice(-12)
    .map(m => ({ role: m.role, content: m.content.slice(0, 2000) }));

  if (!cleanMessages.length || cleanMessages[cleanMessages.length - 1].role !== 'user') {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'ultima mensagem deve ser do usuario' }) };
  }

  // Monta contexto do atleta para o system prompt
  const nome = (p.name || 'o atleta').toString().slice(0, 40);
  const linhas = [];
  if (p.sport) linhas.push(`Modalidade: ${p.sport}`);
  if (p.raceName) linhas.push(`Prova-alvo: ${p.raceName}${p.raceDist ? ' (' + p.raceDist + ')' : ''}`);
  if (p.daysToRace != null) linhas.push(`Faltam ${p.daysToRace} dias para a prova`);
  if (p.phase) linhas.push(`Fase atual do plano: ${p.phase}`);
  if (p.week && p.totalWeeks) linhas.push(`Semana ${p.week} de ${p.totalWeeks}`);
  if (p.level) linhas.push(`Nivel: ${p.level}`);
  if (p.fcMax) linhas.push(`FC maxima: ${p.fcMax} bpm`);
  if (p.weeklyHours) linhas.push(`Disponibilidade semanal: ${p.weeklyHours}`);
  if (p.adherence != null) linhas.push(`Aderencia recente ao plano: ${p.adherence}%`);
  if (p.volume) linhas.push(`Volume recente: ${p.volume}`);
  if (Array.isArray(p.injuries) && p.injuries.length) linhas.push(`Lesoes/restricoes: ${p.injuries.join(', ')}`);
  if (p.constraints) linhas.push(`Observacoes: ${p.constraints}`);

  const contexto = linhas.length ? linhas.join('\n') : 'Perfil ainda nao detalhado.';

  const system = `Voce e o coach de IA do MyTri, um consultor de treino de endurance (corrida, ciclismo, natacao, triathlon) experiente, direto e acolhedor. Voce esta conversando com ${nome}.

CONTEXTO REAL DO ATLETA (use isto para personalizar cada resposta):
${contexto}

Seu papel:
- Responder duvidas sobre treino, plano, execucao das sessoes, lesoes, recuperacao, nutricao, hidratacao e estrategia de prova.
- Sempre considerar o contexto real acima. Se ${nome} tem uma lesao, leve em conta. Se a prova esta perto, ajuste o tom. Se a aderencia esta baixa, seja realista e encorajador.
- Dar orientacao pratica e especifica, nao generica.

Limites importantes:
- Voce NAO e medico. Para dores persistentes, lesoes serias ou questoes de saude/medicacao, oriente a procurar um profissional de saude (medico, fisioterapeuta, nutricionista). Pode dar orientacao geral de treino, mas nao diagnostique nem prescreva medicamento.
- Se perguntarem algo totalmente fora de esporte/saude/treino, redirecione gentilmente para o foco do app.

Formato:
- Responda em portugues do Brasil, tom de conversa (segunda pessoa), direto ao ponto.
- Sem markdown pesado, sem bullet points longos, sem emojis. Texto corrido, no maximo 2 paragrafos curtos.
- Seja conciso: e um chat, nao um relatorio.`;

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
        max_tokens: 700,
        system,
        messages: cleanMessages,
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
