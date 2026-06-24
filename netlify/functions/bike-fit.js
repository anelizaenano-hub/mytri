exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    return { statusCode: 500, body: JSON.stringify({ error: 'No API key' }) };
  }

  let parsed;
  try { parsed = JSON.parse(event.body); }
  catch(e) { return { statusCode: 400, body: JSON.stringify({ error: 'Bad JSON' }) }; }

  const messages = [{ 
    role: 'user', 
    content: parsed.imageBase64 
      ? [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: parsed.imageBase64 } },
          { type: 'text', text: parsed.prompt }
        ]
      : [{ type: 'text', text: parsed.prompt }]
  }];

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({ model: 'claude-haiku-4-5', max_tokens: 1500, messages })
  });

  const data = await resp.json();
  if (!resp.ok) return { statusCode: resp.status, body: JSON.stringify({ error: data.error?.message || 'API error' }) };

  const text = data.content?.map(b => b.text || '').join('') || '';
  return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) };
};
