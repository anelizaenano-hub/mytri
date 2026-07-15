// Netlify Function: create-verification-session.js
// Cria uma sessao de verificacao de identidade real (documento + prova de vida + comparacao
// facial) na Didit, pro Clube da Meia Azul. Retorna a URL hospedada pela Didit — o app so
// precisa redirecionar/abrir essa URL, a Didit cuida de toda a captura de camera.

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
  const HEADERS = { 'Content-Type': 'application/json' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: HEADERS, body: JSON.stringify({ error: 'Method not allowed' }) };

  const user = await verifyAuth(event);
  if (!user) return { statusCode: 401, headers: HEADERS, body: JSON.stringify({ error: 'Nao autenticado.' }) };

  const DIDIT_API_KEY = process.env.DIDIT_API_KEY;
  const DIDIT_WORKFLOW_ID = process.env.DIDIT_WORKFLOW_ID;
  if (!DIDIT_API_KEY || !DIDIT_WORKFLOW_ID) {
    return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ error: 'Verificacao de identidade nao configurada (falta DIDIT_API_KEY ou DIDIT_WORKFLOW_ID nas variaveis de ambiente).' }) };
  }

  // URL do proprio site, pra montar o webhook de callback dinamicamente (funciona em prod e preview).
  const siteUrl = process.env.URL || 'https://nano-tri-v2.netlify.app';

  try {
    const r = await fetch('https://verification.didit.me/v3/session/', {
      method: 'POST',
      headers: { 'x-api-key': DIDIT_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        workflow_id: DIDIT_WORKFLOW_ID,
        vendor_data: user.id, // assim o webhook sabe pra qual usuario do MyTri o resultado pertence
        callback: `${siteUrl}/.netlify/functions/didit-webhook`,
      }),
    });
    const data = await r.json();
    if (!r.ok) {
      return { statusCode: 502, headers: HEADERS, body: JSON.stringify({ error: 'Erro na Didit', detail: data }) };
    }
    return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ url: data.url, session_id: data.session_id }) };
  } catch (e) {
    return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ error: e.message }) };
  }
};
