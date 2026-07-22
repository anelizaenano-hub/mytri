// Function rapida e sincrona (nao background) — so consulta a linha do atleta na tabela
// mytri_plan_summaries. O cliente chama essa em loop (polling) ate o status virar done/error,
// enquanto a plan-summary-background.js faz o trabalho pesado por tras.

const SUPABASE_URL = 'https://dlahyvsrqouxlalqexrp.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_mVgR-2qjgAGzEBeitJ8SAg_DTFYuw-t';

async function verifyAuthAndGetToken(event) {
  const auth = (event.headers && (event.headers.authorization || event.headers.Authorization)) || '';
  const token = auth.replace(/^Bearer\s+/i, '');
  if (!token) return null;
  try {
    const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` }
    });
    if (!r.ok) return null;
    const user = await r.json();
    return (user && user.id) ? { user, token } : null;
  } catch (e) { return null; }
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') return { statusCode: 405, body: 'Method Not Allowed' };

  const auth = await verifyAuthAndGetToken(event);
  if (!auth) return { statusCode: 401, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Nao autenticado.' }) };

  try {
    // Usa o token do proprio usuario (nao a service key) — a policy select_own_summary do RLS
    // ja garante que so a linha dele volta, e isso e defesa em profundidade alem do filtro abaixo.
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/mytri_plan_summaries?user_id=eq.${auth.user.id}&select=status,text_result,error_message,updated_at`,
      { headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${auth.token}` } }
    );
    if (!r.ok) return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'pending' }) };
    const rows = await r.json();
    const row = (Array.isArray(rows) && rows[0]) || { status: 'pending' };
    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(row) };
  } catch (e) {
    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'pending' }) };
  }
};
