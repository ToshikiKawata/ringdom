import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';

export const config = { runtime: 'edge' };

// ── RINGDOM v2 (ネイティブアプリ) 専用: リーク分析 ──
// v2 の Critique 履歴から繰り返しの判断ミス(リーク)を抽出し、
// v2 の Leak[] 型そのままの JSON を返す。認証は x-app-token。

// env値の貼り付け事故（引用符・改行・空白の混入）を自動除去する
function cleanEnv(name) {
  return (process.env[name] || '').trim().replace(/^["']|["']$/g, '');
}

// レート制限: 1デバイスにつき 1時間 5回まで (v1 と同水準)
let ratelimit = null;
{
  const url = cleanEnv('UPSTASH_REDIS_REST_URL');
  const token = cleanEnv('UPSTASH_REDIS_REST_TOKEN');
  if (url && token) {
    if (!url.startsWith('https://')) {
      console.error('ratelimit_init_failed', 'URL is not https:// (REST APIのURLを使うこと)');
    } else {
      try {
        ratelimit = new Ratelimit({
          redis: new Redis({ url, token }),
          limiter: Ratelimit.slidingWindow(5, '1 h'),
          analytics: true,
          prefix: 'v2leaks',
        });
      } catch (e) {
        console.error('ratelimit_init_failed', e?.message);
        ratelimit = null;
      }
    }
  } else {
    console.error('ratelimit_disabled', 'UPSTASH env vars missing');
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

// JSONレスポンス共通ヘルパー（CORSヘッダを毎回付与し漏れを防ぐ）
function json(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  });
}

// レート制限・計測の単位。デバイスID優先（IPはキャリアCGNATで他人と共有されるため）
function rateKey(req) {
  const device = req.headers.get('x-device-id');
  if (device) return `d:${device.slice(0, 64)}`;
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
  return `ip:${ip}`;
}

// ログ用の短縮ハッシュ（生のデバイスIDをログに残さない）
async function deviceHash(req) {
  const device = req.headers.get('x-device-id');
  if (!device) return 'no-device';
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(device));
  return [...new Uint8Array(buf)]
    .slice(0, 8)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export default async function handler(req) {
  // CORS preflight（Web版開発/デバッグ時のみ経由。実機ネイティブは対象外だが
  // 同一オリジンチェックはしない＝認証は下のx-app-tokenのみで担保）
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, x-app-token, x-device-id',
      },
    });
  }
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  const expected = process.env.RINGDOM_APP_TOKEN;
  if (!expected) {
    return json({ error: 'server_not_configured' }, 500);
  }
  if (req.headers.get('x-app-token') !== expected) {
    return json({ error: 'forbidden' }, 403);
  }

  if (ratelimit) {
    const { success } = await ratelimit.limit(`v2l:${rateKey(req)}`);
    if (!success) {
      return json({ error: 'rate_limited', message: '少し時間を空けて再度お試しください' }, 429);
    }
  }

  try {
    const body = await req.json();
    const critiques = Array.isArray(body?.critiques) ? body.critiques : [];

    if (critiques.length < 10) {
      return json({ error: 'insufficient_history' }, 400);
    }
    if (critiques.length > 30) critiques.length = 30;

    console.log(
      JSON.stringify({
        event: 'v2_leaks',
        timestamp: new Date().toISOString(),
        device: await deviceHash(req),
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
      return json({ error: 'upstream_error' }, 502);
    }

    const parsed = extractJson(data?.content?.[0]?.text ?? '');
    const leaks = Array.isArray(parsed?.leaks) ? parsed.leaks : [];
    return json({ leaks }, 200);
  } catch (e) {
    console.error('v2_leaks_failed', e?.message);
    return json({ error: e.message }, 500);
  }
}
