import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';

export const config = { runtime: 'edge' };

// ── RINGDOM v2 (ネイティブアプリ) 専用: リーク分析 ──
// v2 の Critique 履歴から繰り返しの判断ミス(リーク)を抽出し、
// v2 の Leak[] 型そのままの JSON を返す。認証は x-app-token。

// レート制限: 1 IP につき 1時間 5回まで (v1 と同水準)
let ratelimit = null;
if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
  try {
    ratelimit = new Ratelimit({
      redis: Redis.fromEnv(),
      limiter: Ratelimit.slidingWindow(5, '1 h'),
      analytics: true,
      prefix: 'v2leaks',
    });
  } catch (e) {
    console.error('ratelimit_init_failed', e?.message);
    ratelimit = null;
  }
}

const SYSTEM_PROMPT = `あなたはCash Game(リングゲーム)専門のプロポーカーコーチ。
プレイヤーの添削履歴から、繰り返されている判断ミスのパターン(=リーク)を抽出する。

# ルール
- 単発のミスは無視。**複数ハンドにまたがる傾向**のみリークと呼ぶ
- リークは1〜5個。evImpactBb が負の添削を優先的に分析
- title は日本語20字以内 (例: '弱いエースの過大評価')
- count はそのパターンに該当する添削の数
- trend は直近(履歴の後半)で増えていれば "up"、減っていれば "down"、変わらなければ "flat"
- evLossBbPerMonth は該当添削の |evImpactBb| 合計を月換算した目安 (正の数)
- advice は実行可能な具体指示150字以内。NGワード: "気をつける", "意識する", "考える"
- rank は evLossBbPerMonth の大きい順に 1 から

# 出力形式
**必ず以下のJSONのみ**を返す。前置き・後書き・コードフェンス・説明文は一切禁止。
{
  "leaks": [
    {
      "rank": number,
      "title": "string (20字)",
      "count": number,
      "trend": "up" | "flat" | "down",
      "evLossBbPerMonth": number,
      "advice": "string (150字)"
    }
  ]
}`;

function buildUserPrompt(critiques) {
  const compact = critiques.map((c, i) => ({
    idx: i,
    grade: c.grade,
    evImpactBb: c.evImpactBb,
    focusStreet: c.focusStreet,
    yourLine: c.yourLine,
    recommendedLine: c.recommendedLine,
    tags: c.tags,
    why: (c.why || '').slice(0, 120),
  }));
  return `以下、最新${compact.length}件の添削履歴(古い→新しい):\n\n${JSON.stringify(compact, null, 2)}\n\nこの履歴から、繰り返されている判断ミスを抽出して指定JSON形式で返してください。`;
}

function extractJson(text) {
  const stripped = text.replace(/```json|```/g, '').trim();
  const start = stripped.indexOf('{');
  const end = stripped.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('no_json_in_response');
  return JSON.parse(stripped.slice(start, end + 1));
}

export default async function handler(req) {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  const expected = process.env.RINGDOM_APP_TOKEN;
  if (!expected) {
    return new Response(JSON.stringify({ error: 'server_not_configured' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  if (req.headers.get('x-app-token') !== expected) {
    return new Response(JSON.stringify({ error: 'forbidden' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (ratelimit) {
    const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
    const { success } = await ratelimit.limit(`v2l:${ip}`);
    if (!success) {
      return new Response(
        JSON.stringify({ error: 'rate_limited', message: '少し時間を空けて再度お試しください' }),
        { status: 429, headers: { 'Content-Type': 'application/json' } }
      );
    }
  }

  try {
    const body = await req.json();
    const critiques = Array.isArray(body?.critiques) ? body.critiques : [];

    if (critiques.length < 10) {
      return new Response(JSON.stringify({ error: 'insufficient_history' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (critiques.length > 30) critiques.length = 30;

    console.log(
      JSON.stringify({
        event: 'v2_leaks',
        timestamp: new Date().toISOString(),
        country: req.headers.get('x-vercel-ip-country') || 'unknown',
        critiqueCount: critiques.length,
      })
    );

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 2000,
        temperature: 0.4,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: buildUserPrompt(critiques) }],
      }),
    });

    const data = await response.json();
    if (!response.ok) {
      console.error('anthropic_error', JSON.stringify(data?.error || {}));
      return new Response(JSON.stringify({ error: 'upstream_error' }), {
        status: 502,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const parsed = extractJson(data?.content?.[0]?.text ?? '');
    const leaks = Array.isArray(parsed?.leaks) ? parsed.leaks : [];
    return new Response(JSON.stringify({ leaks }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (e) {
    console.error('v2_leaks_failed', e?.message);
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
