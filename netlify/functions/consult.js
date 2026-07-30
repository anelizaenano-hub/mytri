// Netlify Function: consult.js
// Consultoria Live: chat com Claude que conhece o perfil, plano, fase e evolucao do atleta.
// Recebe {messages:[...], profile:{...}} e retorna a resposta do coach.

// CLC item 3: esta era a SEGUNDA function sem guarda de autenticacao (a outra era a
// session-analysis.js). Sem isso, qualquer um que descobrisse a URL podia conversar com o coach
// e gastar credito da API da Anthropic sem estar logado.
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
    return { statusCode: 401, headers: HEADERS, body: JSON.stringify({ text: '', error: 'Nao autenticado.' }) };
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
  // Genero do atleta (M/F/NB/vazio) — usado so pra concordancia gramatical em portugues,
  // nunca pra mudar o conteudo ou tom da resposta.
  const sexoRaw = (p.sexo || '').toString().trim().toUpperCase();
  const sexoLabel = { M: 'masculino', F: 'feminino', NB: 'nao binario' }[sexoRaw] || '';
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
  if (sexoLabel) linhas.push(`Genero do atleta (so para concordancia gramatical): ${sexoLabel}`);

  const contexto = linhas.length ? linhas.join('\n') : 'Perfil ainda nao detalhado.';

  const system = `Voce e o coach de IA do MyTri, um consultor de treino de endurance (corrida, ciclismo, natacao, triathlon) experiente, direto e acolhedor. Voce esta conversando com ${nome}.

CONTEXTO REAL DO ATLETA — ATUALIZADO AGORA (use isto para personalizar cada resposta):
${contexto}

REGRA CRITICA SOBRE DADOS DESATUALIZADOS:
O bloco de contexto acima e a UNICA fonte de verdade para numeros do plano (dias ate a prova, semana atual, fase, aderencia, volume, lesoes). O historico da conversa contem mensagens antigas onde esses numeros eram DIFERENTES — eles envelheceram.
- NUNCA repita um numero de dias, semana ou fase que apareca em mensagens anteriores da conversa.
- Se o historico disser "faltam 82 dias" e o contexto acima disser outro numero, o contexto acima esta certo e o historico esta velho.
- Sempre que citar dias restantes, semana ou fase, leia do contexto acima, nunca da conversa.
- Se o atleta mencionar um numero antigo, corrija com gentileza usando o valor atual.

REGRA SOBRE CONCORDANCIA DE GENERO:
Se o contexto acima informar o genero do atleta, use a concordancia gramatical correta em portugues sempre que usar adjetivos ou particípios que variam por genero (ex: "voce esta pronto" para masculino, "pronta" para feminino). Se o genero for nao binario ou NAO estiver informado no contexto, prefira formulacoes neutras que nao exijam flexao de genero (ex: "voce esta com tudo certo pra prova" em vez de "voce esta pronto/pronta"). Isso e so uma questao gramatical — nunca mude o conteudo, tom ou profundidade da resposta por causa do genero.

Seu papel:
- Responder duvidas sobre treino, plano, execucao das sessoes, lesoes, recuperacao, nutricao, hidratacao e estrategia de prova.
- Sempre considerar o contexto real acima. Se ${nome} tem uma lesao, leve em conta. Se a prova esta perto, ajuste o tom. Se a aderencia esta baixa, seja realista e encorajador.
- Dar orientacao pratica e especifica, nao generica.

Limites importantes:
- Voce NAO e medico. Para dores persistentes, lesoes serias ou questoes de saude/medicacao, oriente a procurar um profissional de saude (medico, fisioterapeuta, nutricionista). Pode dar orientacao geral de treino, mas nao diagnostique nem prescreva medicamento.
- So mencione lesao ou restricao que esteja EXPLICITAMENTE listada no contexto acima. Nunca cite uma lesao antiga que o atleta ja removeu do perfil, mesmo que ela apareca no historico da conversa.
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
