import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';

export const config = { runtime: 'edge' };

const ALLOWED_ORIGINS = [
  'https://ringdom.vercel.app',
  'http://localhost:3000',
];
// Vercel プレビューデプロイURL (例: https://ringdom-git-xxx-toshikikawatas-projects.vercel.app)
const PREVIEW_ORIGIN_REGEX = /^https:\/\/ringdom-[a-z0-9-]+\.vercel\.app$/;

// β期間中の簡易レート制限: 1 IP につき 1時間 5回まで。
// UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN が未設定の環境
// (ローカルなど) では ratelimit=null となり、制限スキップで通す。
let ratelimit = null;
if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
  try {
    ratelimit = new Ratelimit({
      redis: Redis.fromEnv(),
      limiter: Ratelimit.slidingWindow(5, '1 h'),
      analytics: true,
    });
  } catch (e) {
    console.error('ratelimit_init_failed', e?.message);
    ratelimit = null;
  }
}

const SYSTEM_PROMPT = `あなたはCash Game(リングゲーム)専門のプロポーカーコーチ。
プレイヤーの過去のハンド評価履歴から、繰り返されている判断ミスのパターン(=リーク)を抽出する。

# ルール
- 単発のミスは無視。**複数ハンドにまたがる傾向**のみリークと呼ぶ
- リークは3〜5個。star=1〜2 や警告ラベル付き評価を優先的に分析
- 同じストリート×同じ相手タイプでミスが2回以上ある場合のみリーク認定
- severity="high" は「直すと最も期待値が改善する」順に最大2件
- examples には該当する履歴のインデックス(0始まり)を1〜3件列挙
- fix は実行可能な具体指示。NGワード: "気をつける", "意識する", "考える"
- summary は全体傾向を1文60字以内
- strength は良くできている点を1つ80字以内 (継続動機のため必須)

# 出力形式
**必ず以下のJSONのみ**を返す。前置き・後書き・コードフェンス・説明文は一切禁止。

{
  "summary": "string (60字)",
  "leaks": [
    {
      "title": "string (20字)",
      "severity": "high" | "medium" | "low",
      "frequency": "string (例: '12件中5件')",
      "pattern": "string (150字)",
      "examples": [number],
      "fix": "string (150字)"
    }
  ],
  "strength": "string (80字)"
}`;

function buildUserPrompt(history) {
  const compact = history.map((e, i) => ({
    idx: i,
    hand: e.hand,
    board: e.board || null,
    street: e.street,
    action: (e.action || '').slice(0, 200),
    star: (e.rating?.match(/★/g) || []).length,
    label: e.oneline || '',
    comment: (e.comment || '').slice(0, 200),
  }));
  return `以下、最新${compact.length}件の評価履歴(古い→新しい):\n\n${JSON.stringify(compact, null, 2)}\n\nこの履歴から、繰り返されている判断ミスを抽出して指定JSON形式で返してください。`;
}

export default async function handler(req) {
  const origin = req.headers.get('origin') || '';
  const isAllowed = ALLOWED_ORIGINS.includes(origin) || PREVIEW_ORIGIN_REGEX.test(origin);

  // CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': isAllowed ? origin : '',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      },
    });
  }

  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  if (!isAllowed) {
    return new Response(JSON.stringify({ error: 'Forbidden' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // IPベース rate limit (Upstash 設定がある時のみ)
  if (ratelimit) {
    const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
    const { success } = await ratelimit.limit(`leak:${ip}`);
    if (!success) {
      return new Response(JSON.stringify({ error: 'rate_limited', message: '少し時間を空けて再度お試しください' }), {
        status: 429,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': origin },
      });
    }
  }

  try {
    const body = await req.json();
    const history = Array.isArray(body.history) ? body.history : [];

    if (history.length < 10) {
      return new Response(JSON.stringify({ error: 'insufficient_history' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': origin },
      });
    }
    if (history.length > 30) history.length = 30;

    console.log(JSON.stringify({
      event: 'leak_analyze',
      timestamp: new Date().toISOString(),
      country: req.headers.get('x-vercel-ip-country') || 'unknown',
      historyCount: history.length,
    }));

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
        messages: [{ role: 'user', content: buildUserPrompt(history) }],
      }),
    });

    const data = await response.json();
    return new Response(JSON.stringify(data), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': origin },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': origin },
    });
  }
}
