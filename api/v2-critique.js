import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';

export const config = { runtime: 'edge' };

// ── RINGDOM v2 (ネイティブアプリ) 専用: ハンド添削 ──
// 認証は Origin ではなくアプリトークン (x-app-token) で行う。
// プロンプトとレスポンス整形はサーバー側が持ち、クライアントには
// v2 の Critique 型そのままの JSON を返す。

// レート制限: 1 IP につき 1時間 20回まで (添削はプレイ後に数回叩く想定)
let ratelimit = null;
if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
  try {
    ratelimit = new Ratelimit({
      redis: Redis.fromEnv(),
      limiter: Ratelimit.slidingWindow(20, '1 h'),
      analytics: true,
      prefix: 'v2critique',
    });
  } catch (e) {
    console.error('ratelimit_init_failed', e?.message);
    ratelimit = null;
  }
}

const SYSTEM_PROMPT = `あなたはCash Game(リングゲーム)専門のプロポーカーコーチ。初級〜中級者のハンドを添削する。

# ルール
- 対象は低ステークス(NL25〜NL100)の6-maxキャッシュゲーム
- evImpactBb は「その判断がEVに与えた影響(bb)」。良い判断なら正、ミスなら負
- grade は evImpactBb と判断の質から: A(+0.3以上) / B+(0以上) / B(-0.5以上) / B-(-1.0以上) / C(-1.8以上) / D(それ未満) を目安に
- why は代替ラインの理由を150字以内、平易な日本語で。専門用語には短い補足を
- onePoint は次に活かせる一般化した教訓を100字以内
- tags は 1つ目に判断ミスのパターン名(英語2語以内, 例: "Missed Value","Overcall","Weak Ace","Good line")、2つ目にストリート名
- 良いプレイなら素直に褒める(recommendedLine は本人のラインをそのまま)

# 出力形式
**必ず以下のJSONのみ**を返す。前置き・後書き・コードフェンス・説明文は一切禁止。
{
  "grade": "A" | "B+" | "B" | "B-" | "C" | "D",
  "evImpactBb": number,
  "focusStreet": "preflop" | "flop" | "turn" | "river",
  "yourLine": "string (例: 'Turn: Check')",
  "recommendedLine": "string (例: 'Turn: Bet 2/3 pot')",
  "why": "string (150字)",
  "onePoint": "string (100字)",
  "tags": ["string"],
  "equityPct": number
}`;

function buildUserPrompt(hand) {
  const actions = (hand.actions || [])
    .map((a) => `${a.street}: ${a.action}${a.sizePct ? ` ${a.sizePct}%pot` : ''}`)
    .join(' / ');
  return [
    `ステークス: ${hand.stakes}, Hero: ${hand.heroPosition}, Villain: ${hand.villainPosition}`,
    `ホールカード: ${(hand.holeCards || []).join(' ')}`,
    `ボード: ${(hand.board || []).join(' ') || '(preflop)'}`,
    `Heroのアクション: ${actions}`,
    hand.situationNote ? `状況メモ: ${hand.situationNote}` : '',
    '',
    'このハンドを添削し、指定JSON形式のみで返してください。',
  ]
    .filter(Boolean)
    .join('\n');
}

// Claudeの応答テキストからJSONを取り出す (コードフェンス混入に耐性を持たせる)
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

  // ── アプリトークン認証 (env未設定時は fail close) ──
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
    const { success } = await ratelimit.limit(`v2c:${ip}`);
    if (!success) {
      return new Response(
        JSON.stringify({ error: 'rate_limited', message: '少し時間を空けて再度お試しください' }),
        { status: 429, headers: { 'Content-Type': 'application/json' } }
      );
    }
  }

  try {
    const body = await req.json();
    const hand = body?.hand;
    if (!hand || !hand.stakes || !Array.isArray(hand.holeCards) || hand.holeCards.length !== 2) {
      return new Response(JSON.stringify({ error: 'invalid_hand' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    console.log(
      JSON.stringify({
        event: 'v2_critique',
        timestamp: new Date().toISOString(),
        country: req.headers.get('x-vercel-ip-country') || 'unknown',
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
        max_tokens: 1200,
        temperature: 0.3,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: buildUserPrompt(hand) }],
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

    const critique = extractJson(data?.content?.[0]?.text ?? '');
    return new Response(JSON.stringify(critique), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (e) {
    console.error('v2_critique_failed', e?.message);
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
