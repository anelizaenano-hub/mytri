// Netlify Function: session-analysis.js
// Report pos-treino: analisa UMA sessao executada (dados reais do Strava/manual) contra o
// que foi planejado, e devolve um comentario curto e util do coach.
// Recebe { session:{type,text,dist,plannedDist,volComparison}, strava, profile, daysToRace, week, phase }
// Retorna { text }

const https = require('https');

exports.handler = async (event) => {
  const HEADERS = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: HEADERS, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: HEADERS, body: JSON.stringify({ error: 'Method not allowed' }) };

  const API_KEY = process.env.ANTHROPIC_API_KEY;
  if (!API_KEY) return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ text: '', error: 'ANTHROPIC_API_KEY nao configurada' }) };

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch (e) { return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'JSON invalido' }) }; }

  const s = body.session || {};
  const strava = (body.strava || '').toString().slice(0, 500);
  const nome = ((body.profile && body.profile.name) || 'o atleta').toString().slice(0, 40);
  // Lesoes/restricoes ATUAIS (vem sempre do perfil corrente, nunca de cache) — garante que o
  // coach nunca comente sobre uma restricao antiga que o atleta ja atualizou no onboarding.
  const injuries = (body.profile && Array.isArray(body.profile.injuries)) ? body.profile.injuries.filter(i=>i&&i!=='nenhuma') : [];
  const injuryDetail = ((body.profile && body.profile.injuryDetail) || '').toString().slice(0, 200);
  const daysToRace = body.daysToRace;
  const phase = (body.phase || 'Base').toString().slice(0, 40);
  const week = body.week;

  const tipoNome = { swim:'natacao', bike:'bike', run:'corrida', brick:'tijolo (bike+corrida)', gym:'forca', tennis:'tenis' }[s.type] || (s.type||'treino');

  // Contexto do que foi planejado vs feito
  const ctx = [];
  ctx.push(`Modalidade: ${tipoNome}`);
  if (s.text) ctx.push(`Sessao planejada: ${s.text}`);
  if (s.plannedDist) ctx.push(`Distancia PLANEJADA: ${s.plannedDist}`);
  ctx.push(`Dados REAIS executados: ${strava || 'sem dados detalhados'}`);
  if (s.volComparison) ctx.push(`COMPARACAO VOLUME: ${s.volComparison}`);
  if (phase) ctx.push(`Fase do plano: ${phase}`);
  if (week) ctx.push(`Semana ${week}`);
  if (daysToRace != null) ctx.push(`Faltam ${daysToRace} dias para a prova`);
  if (injuries.length) ctx.push(`Lesoes/restricoes ATUAIS do atleta: ${injuries.join(', ')}${injuryDetail ? ' — ' + injuryDetail : ''}`);
  else ctx.push(`Sem lesoes ou restricoes reportadas no momento.`);

  const systemPrompt = `Voce e o coach do MyTri, um app brasileiro de treino para triathlon e endurance. Analise a sessao de treino que ${nome} acabou de executar e escreva um comentario CURTO e util, em portugues do Brasil, tom direto e motivador (nunca bajulador).

REGRAS:
- Maximo 3 a 4 frases curtas. Sem markdown, sem titulos, sem listas, sem emojis.
- Se o atleta fez volume ACIMA do planejado: reconheca, mas comente o impacto na recuperacao e no restante da semana (nao incentive exagero cronico).
- Se fez ABAIXO: comente de forma construtiva, sem culpa, focando em consistencia.
- Se fez proximo do planejado: reforce a execucao consistente.
- Considere a fase do plano e a proximidade da prova.
- So mencione lesao/restricao se ela estiver EXPLICITAMENTE listada no contexto como atual — nunca cite uma lesao que nao esteja la, mesmo que pareca familiar.
- Fale com o atleta na segunda pessoa (voce).
- Nunca invente dados que nao estao no contexto.`;

  const userPrompt = `Contexto da sessao:\n${ctx.join('\n')}\n\nEscreva o comentario do coach sobre esta sessao.`;

  const reqBody = JSON.stringify({
    model: 'claude-haiku-4-5',
    max_tokens: 400,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }],
  });

  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(reqBody),
      },
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.type === 'error' || parsed.error) {
            const msg = (parsed.error && (parsed.error.message || parsed.error.type)) || 'erro API';
            return resolve({ statusCode: 200, headers: HEADERS, body: JSON.stringify({ text: '', error: msg }) });
          }
          const text = (parsed.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
          resolve({ statusCode: 200, headers: HEADERS, body: JSON.stringify({ text }) });
        } catch (e) {
          resolve({ statusCode: 200, headers: HEADERS, body: JSON.stringify({ text: '', error: 'parse' }) });
        }
      });
    });
    req.on('error', (e) => resolve({ statusCode: 200, headers: HEADERS, body: JSON.stringify({ text: '', error: e.message }) }));
    req.write(reqBody);
    req.end();
  });
};
