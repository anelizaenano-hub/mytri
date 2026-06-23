exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  try {
    const body = JSON.parse(event.body);
    const { profile } = body;

    const prompt = `Você é um coach de triathlon experiente. Com base no perfil abaixo, crie um resumo estratégico do plano de treino até a prova. Seja direto, motivador e específico. Responda em português.

PERFIL DO ATLETA:
- Nome: ${profile.name || 'Atleta'}
- Idade: ${profile.age || '?'} anos
- Peso: ${profile.weight || '?'}kg | Altura: ${profile.altura || '?'}cm
- FC Máxima: ${profile.fcMax || '?'}bpm
- Prova: ${profile.raceName || 'Sprint Triathlon'}
- Distância: ${profile.raceDist || 'sprint'}
- Data da prova: ${profile.raceDate || '?'}
- Meta: ${profile.goalTime || 'completar a prova'}
- Horas de treino/semana: ${profile.weeklyHours || '3-4'}h
- Natação: ${profile.swimLevel || 'iniciante'} | Pace: ${profile.swim || 'não informado'}
- Bike: ${profile.bikeLevel || 'iniciante'} | FTP: ${profile.ftp || 'não informado'}
- Corrida: ${profile.runLevel || 'iniciante'} | Pace: ${profile.pace || 'não informado'}

Crie um resumo com exatamente estas seções (use estes títulos):

VISÃO GERAL
2-3 frases resumindo a situação e o objetivo principal.

PONTO CRÍTICO
A modalidade ou aspecto que mais vai determinar o resultado. Seja específico.

FASES DO PLANO
Liste 3-4 fases com nome e foco principal (ex: "Base — construção aeróbica e técnica de nado").

ESTRATÉGIA DE PROVA
2-3 frases sobre como abordar o dia da prova dado o perfil.

MENSAGEM DO COACH
Uma frase motivadora e personalizada para este atleta específico.`;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5',
        max_tokens: 1000,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    const data = await response.json();

    if (!response.ok) {
      return { statusCode: response.status, body: JSON.stringify({ error: data.error?.message || 'API error' }) };
    }

    const text = data.content?.map(b => b.text || '').join('') || '';
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text })
    };

  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
};
