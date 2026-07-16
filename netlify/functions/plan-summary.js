const https = require('https');

// CLC item 3: valida o token de sessao do Supabase antes de gastar credito de API — sem isso,
// qualquer pessoa que descobrisse essa URL conseguia chamar direto, sem estar logada no app.
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
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };
  const user = await verifyAuth(event);
  if (!user) return { statusCode: 401, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Nao autenticado.' }) };
  let profile;
  try { profile = JSON.parse(event.body).profile; } catch { return { statusCode: 400, body: 'Invalid JSON' }; }

  const sport = profile.sport || 'triathlon';
  const sportNames = { triathlon:'Triathlon', corrida:'Corrida', ciclismo:'Ciclismo', natacao:'Natacao', duathlon:'Duathlon' };
  const sportName = sportNames[sport] || sport;
  const raceName = profile.raceName || profile.nextRace || 'prova principal';
  const raceDate = profile.raceDate || '';
  const goalTime = profile.goalTime || '';
  const daysToRace = raceDate ? Math.max(0, Math.round((new Date(raceDate + 'T12:00:00') - new Date()) / (1000*60*60*24))) : '?';
  // Pace/velocidade NECESSARIO, distancias EXATAS da prova, e o veredito da comparacao pace
  // atual vs necessario — tudo isso ja vem calculado pronto do front-end. NAO deixar o modelo
  // calcular nada disso de cabeca: ja aconteceu de inventar distancias de outra prova inteira
  // (ex: "1h9 de natacao e 90km de bike" pra um sprint, que e 750m/20km/5km) e de inverter ou
  // trocar o resultado da comparacao de pace entre uma chamada e outra.
  const paceNecessario = profile.paceNecessarioMeta || '';
  const distanciasProva = profile.distanciasProva || '';
  const comparacaoPace = profile.comparacaoPace || '';

  // Níveis por modalidade
  let levelStr = '';
  if (sport === 'triathlon' || sport === 'duathlon') {
    levelStr = `Natacao: ${profile.swimLevel||'iniciante'} (${profile.swim||'?'}/100m), Bike: ${profile.bikeLevel||'iniciante'} (FTP ${profile.ftp||'?'}w), Corrida: ${profile.runLevel||'iniciante'} (${profile.pace||'?'}/km)`;
  } else if (sport === 'corrida') {
    levelStr = `Nivel: ${profile.runLevel||'iniciante'}, Pace atual: ${profile.pace||'?'}/km`;
  } else if (sport === 'ciclismo') {
    levelStr = `Nivel: ${profile.bikeLevel||'iniciante'}, FTP: ${profile.ftp||'?'}w`;
  } else if (sport === 'natacao') {
    levelStr = `Nivel: ${profile.swimLevel||'iniciante'}, Pace: ${profile.swim||'?'}/100m`;
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

  const requestBody = JSON.stringify({
    model: 'claude-sonnet-4-5',
    max_tokens: 1600,
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
          resolve({ statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
        } catch { resolve({ statusCode: 500, body: JSON.stringify({ text: '' }) }); }
      });
    });
    req.on('error', () => resolve({ statusCode: 500, body: JSON.stringify({ text: '' }) }));
    req.write(requestBody);
    req.end();
  });
};
