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
- エフェクティブスタック(bb)が与えられる。SPRを考慮して評価する
- プリフロップの状況（オープン/レイズに直面/3ベットに直面）が与えられる。「レイズに直面」でHeroがraiseなら3ベット、「3ベットに直面」でraiseなら4ベット
- ポストフロップは「直面した相手のベット(pot比%)」が与えられる。コール/フォールドの是非は必ずこの価格（ポットオッズ）を踏まえて評価する。チェックに直面(0%)の場合はベット/チェックの選択として評価
- マルチウェイ(3人以上)の場合はレンジの強さ・ブラフ頻度の前提を調整する
- evImpactBb は「その判断がEVに与えた影響(bb)」。良い判断なら正、ミスなら負
- grade は evImpactBb と判断の質から: A(+0.3以上) / B+(0以上) / B(-0.5以上) / B-(-1.0以上) / C(-1.8以上) / D(それ未満) を目安に
- why は代替ラインの理由を150字以内、平易な日本語で。専門用語には短い補足を
- onePoint は次に活かせる一般化した教訓を100字以内
- tags は 1つ目に判断ミスのパターン名(英語2語以内, 例: "Missed Value","Overcall","Weak Ace","Good line")、2つ目にストリート名
- 良いプレイなら素直に褒める(recommendedLine は本人のラインをそのまま)
- yourLine/recommendedLine のサイズ表記はプリフロップ=bb建て(例: 'Preflop: Raise 2.5bb')、ポストフロップ=pot比(例: 'Turn: Bet 66% pot')

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

const PREFLOP_FACING_LABEL = {
  none: '誰も参加していない(未オープン)',
  open: 'オープンレイズに直面',
  threebet: '3ベットに直面',
};

function buildUserPrompt(hand) {
  const actions = (hand.actions || [])
    .map((a) => {
      const size = a.sizeBb ? ` ${a.sizeBb}bb` : a.sizePct ? ` ${a.sizePct}%pot` : '';
      const facing =
        a.street !== 'preflop'
          ? a.facingPct
            ? `(相手の${a.facingPct}%potベットに直面) `
            : '(チェックに直面) '
          : '';
      return `${a.street}: ${facing}${a.action}${size}`;
    })
    .join(' / ');
  const players = (hand.players ?? 2) >= 3 ? 'マルチウェイ(3人以上)' : 'ヘッズアップ';
  return [
    `ステークス: ${hand.stakes}, エフェクティブスタック: ${hand.effectiveBb ?? 100}bb, Hero: ${hand.heroPosition}, Villain: ${hand.villainPosition}, ${players}`,
    `プリフロップ状況: ${PREFLOP_FACING_LABEL[hand.preflopFacing] ?? PREFLOP_FACING_LABEL.none}`,
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

// JSONレスポンス共通ヘルパー（CORSヘッダを毎回付与し漏れを防ぐ）
function json(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  });
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
        'Access-Control-Allow-Headers': 'Content-Type, x-app-token',
      },
    });
  }
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  // ── アプリトークン認証 (env未設定時は fail close) ──
  const expected = process.env.RINGDOM_APP_TOKEN;
  if (!expected) {
    return json({ error: 'server_not_configured' }, 500);
  }
  if (req.headers.get('x-app-token') !== expected) {
    return json({ error: 'forbidden' }, 403);
  }

  if (ratelimit) {
    const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
    const { success } = await ratelimit.limit(`v2c:${ip}`);
    if (!success) {
      return json({ error: 'rate_limited', message: '少し時間を空けて再度お試しください' }, 429);
    }
  }

  try {
    const body = await req.json();
    const hand = body?.hand;
    if (!hand || !hand.stakes || !Array.isArray(hand.holeCards) || hand.holeCards.length !== 2) {
      return json({ error: 'invalid_hand' }, 400);
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
      return json({ error: 'upstream_error' }, 502);
    }

    const critique = extractJson(data?.content?.[0]?.text ?? '');
    return json(critique, 200);
  } catch (e) {
    console.error('v2_critique_failed', e?.message);
    return json({ error: e.message }, 500);
  }
}
