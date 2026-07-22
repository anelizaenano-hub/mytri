// BACKGROUND FUNCTION — mesmo padrao do plan-summary-background.js. A analise de bike fit
// SEMPRE envolveu o mesmo problema de arquitetura: function sincrona (exports.handler classico)
// chamando a Anthropic com uma imagem anexada (analise visual e mais lenta que so texto) e
// max_tokens alto — presa no mesmo teto de ~26-30s do gateway sincrono da Netlify. "Load failed"
// no Safari e esse mesmo estouro de tempo, so que aparece como erro de rede generico em vez de
// um 504 explicito porque o payload da foto deixa a chamada mais pesada.
//
// Nome do arquivo com sufixo -background (convencao mais confiavel da Netlify, testada agora no
// plan-summary). Cliente recebe 202 na hora, function roda ate 15 minutos por tras, grava o
// resultado em mytri_bikefit_analyses quando termina.

const SUPABASE_URL = 'https://dlahyvsrqouxlalqexrp.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_mVgR-2qjgAGzEBeitJ8SAg_DTFYuw-t';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

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

async function upsertResult(userId, fields) {
  if (!SUPABASE_SERVICE_ROLE_KEY) { console.log('[bike-fit-bg] SUPABASE_SERVICE_ROLE_KEY nao configurada, nao consigo gravar resultado.'); return; }
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/mytri_bikefit_analyses?on_conflict=user_id`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates,return=minimal'
      },
      body: JSON.stringify({ user_id: userId, updated_at: new Date().toISOString(), ...fields })
    });
  } catch (e) { console.log('[bike-fit-bg] falha ao gravar resultado:', e.message); }
}

export default async (req) => {
  const user = await verifyAuth(req);
  if (!user) { console.log('[bike-fit-bg] chamada sem autenticacao valida, abortando.'); return; }

  let body;
  try { body = await req.json(); } catch { console.log('[bike-fit-bg] corpo invalido.'); return; }
  const { prompt, imageBase64 } = body;

  await upsertResult(user.id, { status: 'pending', text_result: null, error_message: null });

  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_API_KEY) {
    await upsertResult(user.id, { status: 'error', error_message: 'API key not configured' });
    return;
  }

  const messages = [{
    role: 'user',
    content: imageBase64 ? [
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: imageBase64 } },
      { type: 'text', text: prompt }
    ] : [{ type: 'text', text: prompt }]
  }];

  try {
    const _t0 = Date.now();
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 2000,
        messages
      })
    });
    const data = await response.json();
    console.log(`[bike-fit-bg] chamada a Anthropic levou ${Date.now() - _t0}ms, HTTP ${response.status}`);

    if (!response.ok) {
      await upsertResult(user.id, { status: 'error', error_message: data.error?.message || `HTTP ${response.status}` });
      return;
    }

    const text = data.content?.map(b => b.text || '').join('') || '';
    await upsertResult(user.id, { status: 'done', text_result: text, error_message: null });
    console.log(`[bike-fit-bg] concluido, ${text.length} caracteres.`);
  } catch (e) {
    console.log('[bike-fit-bg] excecao:', e.message);
    await upsertResult(user.id, { status: 'error', error_message: e.message });
  }
};
