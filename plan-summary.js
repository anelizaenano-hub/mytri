// STREAMING FUNCTION (Netlify Functions v2 — export default + Request/Response padrao da web).
// Motivo da reescrita: a versao antiga (exports.handler classico) sempre estourava 504 porque
// a resposta so e entregue ao cliente DEPOIS que a function inteira termina — e o gateway
// sincrono da Netlify tem um teto fixo de tempo (~26-30s) que nao e configuravel via
// netlify.toml (foi o que quebrou o deploy quando tentamos [functions] timeout=26 antes).
// Streaming resolve isso na raiz: os bytes comecam a chegar no cliente assim que a Anthropic
// comeca a gerar, entao a conexao nunca fica "parada" tempo suficiente pra bater o teto —
// nao importa se o modelo demora 15s ou 35s pra terminar o texto inteiro.
//
// O cliente (index.html/showPlanSummary) le esse stream como TEXTO PURO (nao JSON, nao SSE
// bruto da Anthropic) — esta function ja desembrulha os eventos SSE da Anthropic e repassa só
// o texto de cada pedaco, entao o parsing de secoes (VISAO GERAL/PONTO CRITICO/etc) do lado do
// cliente continua funcionando exatamente igual, sobre o texto final acumulado.

const SUPABASE_URL = 'https://dlahyvsrqouxlalqexrp.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_mVgR-2qjgAGzEBeitJ8SAg_DTFYuw-t';

async function verifyAuth(req) {
  const auth = req.headers.get('authorization') || req.headers.get('Authorization') || '';
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

export default async (req) => {
  if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });

  const user = await verifyAuth(req);
  if (!user) return new Response(JSON.stringify({ error: 'Nao autenticado.' }), { status: 401, headers: { 'Content-Type': 'application/json' } });

  let profile;
  try { profile = (await req.json()).profile; } catch { return new Response('Invalid JSON', { status: 400 }); }

  const sport = profile.sport || 'triathlon';
  const sportNames = { triathlon: 'Triathlon', corrida: 'Corrida', ciclismo: 'Ciclismo', natacao: 'Natacao', duathlon: 'Duathlon' };
  const sportName = sportNames[sport] || sport;
  const raceName = profile.raceName || profile.nextRace || 'prova principal';
  const raceDate = profile.raceDate || '';
  const goalTime = profile.goalTime || '';
  const daysToRace = raceDate ? Math.max(0, Math.round((new Date(raceDate + 'T12:00:00') - new Date()) / (1000 * 60 * 60 * 24))) : '?';
  const paceNecessario = profile.paceNecessarioMeta || '';
  const distanciasProva = profile.distanciasProva || '';
  const comparacaoPace = profile.comparacaoPace || '';

  let levelStr = '';
  if (sport === 'triathlon' || sport === 'duathlon') {
    levelStr = `Natacao: ${profile.swimLevel || 'iniciante'} (${profile.swim || '?'}/100m), Bike: ${profile.bikeLevel || 'iniciante'} (FTP ${profile.ftp || '?'}w), Corrida: ${profile.runLevel || 'iniciante'} (${profile.pace || '?'}/km)`;
  } else if (sport === 'corrida') {
    levelStr = `Nivel: ${profile.runLevel || 'iniciante'}, Pace atual: ${profile.pace || '?'}/km`;
  } else if (sport === 'ciclismo') {
    levelStr = `Nivel: ${profile.bikeLevel || 'iniciante'}, FTP: ${profile.ftp || '?'}w`;
  } else if (sport === 'natacao') {
    levelStr = `Nivel: ${profile.swimLevel || 'iniciante'}, Pace: ${profile.swim || '?'}/100m`;
  }

  const diasStr = profile.diasDisponiveis?.join(', ') || 'seg, ter, qua, qui, sex';
  const horasStr = profile.weeklyHours || '3-4';
  const lesoesStr = (profile.lesoes && profile.lesoes.length > 0 && !profile.lesoes.includes('nenhuma'))
    ? `${profile.lesoes.join(', ')}${profile.lesaoDetalhe ? ' — ' + profile.lesaoDetalhe : ''}`
    : 'Nenhuma restricao reportada';

  const prompt = `Voce e um coach de alto rendimento especialista em ${sportName}. Crie um resumo estrategico do plano de treino personalizado para este atleta:

ATLETA: ${profile.name || 'Atleta'}, ${profile.age || '?'} anos, ${profile.weight || '?'}kg
ESPORTE: ${sportName}
PROVA: ${raceName}
${distanciasProva ? `DISTANCIAS EXATAS DESTA PROVA (use estes numeros literalmente, NUNCA invente ou troque por outra prova): ${distanciasProva}` : ''}
DIAS ATE A PROVA: ${daysToRace} dias
META DE TEMPO: ${goalTime || 'completar a prova'}
${paceNecessario ? `PACE/VELOCIDADE NECESSARIO PARA BATER A META (ja calculado, use este numero, nao recalcule): ${paceNecessario}` : ''}
${comparacaoPace ? `COMPARACAO PACE ATUAL vs NECESSARIO (ja calculada — repita esta conclusao, NAO julgue os numeros de novo nem inverta): ${comparacaoPace}` : ''}
PERFORMANCE ATUAL: ${levelStr}
HORAS SEMANAIS DISPONIVEIS: ${horasStr}h
DIAS DE TREINO: ${diasStr}
FC MAXIMA: ${profile.fcMax || '?'}bpm
LESOES/RESTRICOES: ${lesoesStr}

Escreva o resumo EXCLUSIVAMENTE focado em ${sportName}. NAO mencione outras modalidades a menos que sejam relevantes para o esporte escolhido. Se houver lesoes ou restricoes, considere isso ao montar o ponto critico e a estrategia, evitando exercicios que agravem a condicao.

CRITICO SOBRE NUMEROS: todo numero de distancia, pace, velocidade ou comparacao que aparecer acima ja vem calculado e verificado. Copie e use esses numeros literalmente no seu texto. NUNCA calcule, recalcule, estime ou invente distancias, paces ou comparacoes por conta propria — isso ja causou erros graves (relatorio de uma prova sprint de 750m/20km/5km saiu com "1h9 de natacao e 90km de bike", numeros de uma prova completamente diferente).
${comparacaoPace ? 'Use a COMPARACAO PACE ATUAL vs NECESSARIO fornecida acima exatamente como esta — nao a reescreva com outra conclusao.' : ''}

CRITICO SOBRE O PACE: o campo "PACE/VELOCIDADE NECESSARIO PARA BATER A META" ja vem calculado corretamente (tempo-alvo dividido pela distancia da prova) — nunca recalcule essa conta de cabeca, e nunca inverta a comparacao. Compare esse numero com o pace/nivel ATUAL do atleta (campo PERFORMANCE ATUAL):
- Se o pace ATUAL do atleta ja e IGUAL OU MAIS RAPIDO (numero menor de min/km, ou velocidade maior em km/h, ou pace menor por 100m) que o necessario pra meta, diga isso claramente: o atleta ja tem a capacidade de completar a prova nesse tempo, e o foco do plano deve ser manter essa capacidade com seguranca (evitar lesao, ganhar resistencia especifica pra sustentar o ritmo pela distancia toda), NAO "melhorar o pace".
- Só fale em "precisar melhorar o pace" ou "ganhar velocidade" se o pace atual for de fato MAIS LENTO que o necessario pra meta.
- Nunca calcule diferenca de segundos por km entre pace atual e pace necessario incorretamente — se nao tiver certeza da conta, apenas diga qual dos dois e mais rapido, sem inventar um numero de segundos.

Responda EXATAMENTE neste formato (sem markdown, sem asteriscos, sem ##):

VISAO GERAL
[2-3 paragrafos sobre o perfil do atleta, o desafio da prova e o contexto geral do plano]

PONTO CRITICO
[O maior gargalo ou desafio especifico para este atleta neste esporte. Seja direto e especifico.]

FASES DO PLANO
[4 fases do plano com nome, periodo e objetivos principais. Uma por linha.]

ESTRATEGIA DE PROVA
[Como o atleta deve abordar a prova especifica: ritmo, estrategia, pontos de atencao]

MENSAGEM DO COACH
[Mensagem motivacional personalizada e especifica para este atleta e sua jornada]`;

  const anthropicBody = JSON.stringify({
    model: 'claude-haiku-4-5',
    max_tokens: 1600,
    stream: true,
    messages: [{ role: 'user', content: prompt }]
  });

  let anthropicResp;
  try {
    anthropicResp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: anthropicBody
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: 'Falha de rede ao chamar a API: ' + e.message }), { status: 502, headers: { 'Content-Type': 'application/json' } });
  }

  if (!anthropicResp.ok) {
    let msg = 'Erro na API (HTTP ' + anthropicResp.status + ')';
    try { const errBody = await anthropicResp.json(); msg = errBody.error?.message || msg; } catch (e) {}
    return new Response(JSON.stringify({ error: msg }), { status: anthropicResp.status, headers: { 'Content-Type': 'application/json' } });
  }

  // Desembrulha o SSE da Anthropic (linhas "data: {...}") e repassa so o texto de cada
  // content_block_delta — o cliente recebe texto puro incremental, sem precisar entender o
  // formato de evento da Anthropic.
  const reader = anthropicResp.body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      let buffer = '';
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';
          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            const raw = line.slice(6).trim();
            if (!raw || raw === '[DONE]') continue;
            try {
              const evt = JSON.parse(raw);
              if (evt.type === 'content_block_delta' && evt.delta && typeof evt.delta.text === 'string') {
                controller.enqueue(encoder.encode(evt.delta.text));
              }
            } catch (e) { /* linha SSE incompleta ou nao-JSON, ignora */ }
          }
        }
      } catch (e) {
        console.log('[plan-summary-stream] erro lendo stream da Anthropic:', e.message);
      }
      controller.close();
    }
  });

  return new Response(stream, {
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-cache' }
  });
};
