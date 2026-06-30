const https = require('https');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };
  let profile;
  try { profile = JSON.parse(event.body).profile; } catch { return { statusCode: 400, body: 'Invalid JSON' }; }

  const sport = profile.sport || 'triathlon';
  const sportNames = { triathlon:'Triathlon', corrida:'Corrida', ciclismo:'Ciclismo', natacao:'Natacao', duathlon:'Duathlon' };
  const sportName = sportNames[sport] || sport;
  const raceName = profile.raceName || profile.nextRace || 'prova principal';
  const raceDate = profile.raceDate || '';
  const goalTime = profile.goalTime || '';
  const daysToRace = raceDate ? Math.max(0, Math.round((new Date(raceDate + 'T12:00:00') - new Date()) / (1000*60*60*24))) : '?';

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
DIAS ATE A PROVA: ${daysToRace} dias
META DE TEMPO: ${goalTime || 'completar a prova'}
PERFORMANCE ATUAL: ${levelStr}
HORAS SEMANAIS DISPONIVEIS: ${horasStr}h
DIAS DE TREINO: ${diasStr}
FC MAXIMA: ${profile.fcMax || '?'}bpm
LESOES/RESTRICOES: ${lesoesStr}

Escreva o resumo EXCLUSIVAMENTE focado em ${sportName}. NAO mencione outras modalidades a menos que sejam relevantes para o esporte escolhido. Se houver lesoes ou restricoes, considere isso ao montar o ponto critico e a estrategia, evitando exercicios que agravem a condicao.

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
    model: 'claude-haiku-4-5',
    max_tokens: 800,
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
