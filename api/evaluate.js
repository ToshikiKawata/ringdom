export const config = { runtime: 'edge' };

export default async function handler(req) {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  try {
    const body = await req.json();

    // ── 使用ログ ──────────────────────────────
    const timestamp = new Date().toISOString();
    const ua = req.headers.get('user-agent') || 'unknown';
    const country = req.headers.get('x-vercel-ip-country') || 'unknown';
    console.log(JSON.stringify({
      event: 'ai_evaluate',
      timestamp,
      country,
      ua: ua.slice(0, 80),
    }));

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: body.model || 'claude-sonnet-4-6', // haiku → sonnet に修正
        max_tokens: body.max_tokens || 1000,
        system: body.system,
        messages: body.messages,
      }),
    });

    const data = await response.json();

    return new Response(JSON.stringify(data), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
