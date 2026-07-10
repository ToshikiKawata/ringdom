import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';

export const config = { runtime: 'edge' };

// ── RINGDOM v2 (ネイティブアプリ) 専用: ハンド添削 ──
// 認証は Origin ではなくアプリトークン (x-app-token) で行う。
// プロンプトとレスポンス整形はサーバー側が持ち、クライアントには
// v2 の Critique 型そのままの JSON を返す。

// env値の貼り付け事故（引用符・改行・空白の混入）を自動除去する
function cleanEnv(name) {
  return (process.env[name] || '').trim().replace(/^["']|["']$/g, '');
}

// レート制限: 1デバイスにつき 1時間 20回まで (添削はプレイ後に数回叩く想定)
let ratelimit = null;
{
  const url = cleanEnv('UPSTASH_REDIS_REST_URL');
  const token = cleanEnv('UPSTASH_REDIS_REST_TOKEN');
  if (url && token) {
    if (!url.startsWith('https://')) {
      // redis-cli用のrediss://等を貼った場合はREST APIのURLではない
      console.error('ratelimit_init_failed', 'URL is not https:// (REST APIのURLを使うこと)');
    } else {
      try {
        ratelimit = new Ratelimit({
          redis: new Redis({ url, token }),
          limiter: Ratelimit.slidingWindow(20, '1 h'),
          analytics: true,
          prefix: 'v2critique',
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

const SYSTEM_PROMPT = `あなたはCash Game(リングゲーム)専門のプロポーカーコーチ。初級〜中級者のハンドを添削する。

# ルール
- 対象は低ステークス(NL25〜NL100)想定の6-maxキャッシュゲーム
- エフェクティブスタック(bb)が与えられる。SPRを考慮して評価する
- アクションログは発生順に「ストリート: 主体 アクション サイズ」の形式で、Hero（本人）と相手全員分が時系列で与えられる。Heroの手番の直前に相手のベット/レイズがあればHeroはそれに応答したことになる（コール/フォールドの是非は必ずその価格＝ポットオッズを踏まえて評価する）。直前が相手のチェックまたは相手のアクションが無ければ、Heroはベット/チェックの選択をしたことになる
- 相手が複数人写っている（マルチウェイ、3人以上）場合はレンジの強さ・ブラフ頻度の前提を調整する。誰のアクションかはポジション名で区別されている
- evImpactBb は「Heroの判断がEVに与えた影響(bb)」。良い判断なら正、ミスなら負
- grade は evImpactBb と判断の質から: A(+0.3以上) / B+(0以上) / B(-0.5以上) / B-(-1.0以上) / C(-1.8以上) / D(それ未満) を目安に
- why は代替ラインの理由を150字以内、平易な日本語で。専門用語には短い補足を
- onePoint は次に活かせる一般化した教訓を100字以内
- tags は 1つ目に判断ミスのパターン名(英語2語以内, 例: "Missed Value","Overcall","Weak Ace","Good line")、2つ目にストリート名
- 良いプレイなら素直に褒める(recommendedLine は本人のラインをそのまま)
- yourLine/recommendedLine はHeroの判断のみを対象にする。サイズ表記はプリフロップ=bb建て(例: 'Preflop: Raise 2.5bb')、ポストフロップ=pot比(例: 'Turn: Bet 66% pot')

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
  const actionLines = (hand.actions || [])
    .map((a) => {
      const size = a.sizeBb ? ` ${a.sizeBb}bb` : a.sizePct ? ` ${a.sizePct}%pot` : '';
      const who = a.actor === 'hero' ? 'Hero' : a.actor;
      return `${a.street}: ${who} ${a.action}${size}`;
    })
    .join(' / ');
  const villains = (hand.villainPositions || []).join(', ');
  const multiway = (hand.villainPositions || []).length >= 2 ? 'マルチウェイ(3人以上)' : 'ヘッズアップ';
  return [
    `エフェクティブスタック: ${hand.effectiveBb ?? 100}bb, Hero: ${hand.heroPosition}, 相手: ${villains}, ${multiway}`,
    `ホールカード: ${(hand.holeCards || []).join(' ')}`,
    `ボード: ${(hand.board || []).join(' ') || '(preflop)'}`,
    `アクションログ（発生順、Hero=本人、それ以外はポジション名）: ${actionLines}`,
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

  // ── アプリトークン認証 (env未設定時は fail close) ──
  const expected = process.env.RINGDOM_APP_TOKEN;
  if (!expected) {
    return json({ error: 'server_not_configured' }, 500);
  }
  if (req.headers.get('x-app-token') !== expected) {
    return json({ error: 'forbidden' }, 403);
  }

  if (ratelimit) {
    const { success } = await ratelimit.limit(`v2c:${rateKey(req)}`);
    if (!success) {
      return json({ error: 'rate_limited', message: '少し時間を空けて再度お試しください' }, 429);
    }
  }

  try {
    const body = await req.json();
    const hand = body?.hand;
    if (!hand || !Array.isArray(hand.holeCards) || hand.holeCards.length !== 2) {
      return json({ error: 'invalid_hand' }, 400);
    }

    // 使用量計測（Phase A）: デバイスハッシュ単位でDAU・回数分布をログから集計できるようにする
    console.log(
      JSON.stringify({
        event: 'v2_critique',
        timestamp: new Date().toISOString(),
        device: await deviceHash(req),
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
    // モデルが数値をクォート付きで返すことがあるため正規化（クライアントの.toFixed()対策）
    critique.evImpactBb = Number(critique.evImpactBb) || 0;
    if (critique.equityPct != null) {
      const eq = Number(critique.equityPct);
      critique.equityPct = Number.isFinite(eq) ? eq : undefined;
    }
    if (!Array.isArray(critique.tags)) critique.tags = [];
    return json(critique, 200);
  } catch (e) {
    console.error('v2_critique_failed', e?.message);
    return json({ error: e.message }, 500);
  }
}
