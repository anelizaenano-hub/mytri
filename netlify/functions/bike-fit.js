// CLC item 3 (pendente ate agora - so recebi esse arquivo depois): valida o token de sessao
// do Supabase antes de gastar credito de API — sem isso, qualquer pessoa que descobrisse essa
// URL conseguia chamar direto, sem estar logada no app.
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
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const user = await verifyAuth(event);
  if (!user) {
    return { statusCode: 401, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Nao autenticado.' }) };
  }

  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_API_KEY) {
    return { statusCode: 500, body: JSON.stringify({ error: 'API key not configured' }) };
  }

  let body;
  try { body = JSON.parse(event.body); } 
  catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { prompt, imageBase64 } = body;

  const messages = [{
    role: 'user',
    content: imageBase64 ? [
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: imageBase64 } },
      { type: 'text', text: prompt }
    ] : [{ type: 'text', text: prompt }]
  }];

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        // CORRIGIDO: 'claude-sonnet-4-6' nao e um nome de modelo valido.
        model: 'claude-sonnet-4-5',
        // CORRIGIDO: 1500 era baixo demais pro texto completo (6 secoes) + resumo estruturado
        // — a resposta cortava antes do fim. Aumentado pra dar folga real.
        max_tokens: 2000,
        messages
      })
    });

    const data = await response.json();

    if (!response.ok) {
      return { statusCode: response.status, body: JSON.stringify({ error: data.error?.message || 'API error' }) };
    }

    const text = data.content?.map(b => b.text || '').join('') || '';
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ text })
    };

  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
};
