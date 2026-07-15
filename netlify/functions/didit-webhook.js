// Netlify Function: didit-webhook.js
// Recebe o resultado da verificacao de identidade direto da Didit (server-to-server, sem
// usuario logado no meio) e grava na tabela mytri_identity_verifications.
//
// Usa a chave "service_role" do Supabase (ignora RLS) porque esse e o UNICO lugar que pode
// gravar um resultado de verificacao — de proposito, usuarios normais nao tem permissao de
// escrita nessa tabela (so leitura do proprio resultado), pra ninguem conseguir forjar
// "sou verificado" direto pelo navegador.

const crypto = require('crypto');
const SUPABASE_URL = 'https://dlahyvsrqouxlalqexrp.supabase.co';

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

  const WEBHOOK_SECRET = process.env.DIDIT_WEBHOOK_SECRET;
  const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!WEBHOOK_SECRET || !SERVICE_ROLE_KEY) {
    console.error('DIDIT_WEBHOOK_SECRET ou SUPABASE_SERVICE_ROLE_KEY nao configurada.');
    return { statusCode: 500, body: 'Not configured' };
  }

  // Verifica a assinatura HMAC pra garantir que isso realmente veio da Didit, nao de
  // qualquer um que descobrisse essa URL.
  const signature = event.headers['x-signature'] || event.headers['X-Signature'];
  const timestamp = event.headers['x-timestamp'] || event.headers['X-Timestamp'];
  const rawBody = event.body || '';

  if (timestamp) {
    const age = Math.abs(Date.now() / 1000 - parseInt(timestamp, 10));
    if (age > 300) return { statusCode: 401, body: 'Timestamp expirado' }; // proteção contra replay
  }
  if (signature) {
    const hmac = crypto.createHmac('sha256', WEBHOOK_SECRET);
    const expected = hmac.update(rawBody).digest('hex');
    const a = Buffer.from(expected, 'utf8'), b = Buffer.from(signature, 'utf8');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return { statusCode: 401, body: 'Assinatura invalida' };
    }
  }

  let payload;
  try { payload = JSON.parse(rawBody); } catch (e) { return { statusCode: 400, body: 'JSON invalido' }; }

  const userId = payload.vendor_data; // o user.id do MyTri, passado na criacao da sessao
  const status = payload.status || (payload.decision && payload.decision.status);
  if (!userId || !status) return { statusCode: 200, body: 'Ignorado (sem vendor_data/status)' };

  const idv = (payload.decision && payload.decision.id_verification) || {};
  const verified = status === 'Approved';
  const age = idv.age != null ? idv.age : null;

  try {
    await fetch(`${SUPABASE_URL}/rest/v1/mytri_identity_verifications`, {
      method: 'POST',
      headers: {
        apikey: SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates',
      },
      body: JSON.stringify({
        user_id: userId,
        verified,
        age,
        status,
        session_id: payload.session_id || null,
        verified_at: verified ? new Date().toISOString() : null,
        updated_at: new Date().toISOString(),
      }),
    });
    return { statusCode: 200, body: 'OK' };
  } catch (e) {
    console.error('Erro ao gravar verificacao:', e.message);
    return { statusCode: 500, body: 'Erro ao gravar' };
  }
};
