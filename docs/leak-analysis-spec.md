# リーク分析機能 — 実装仕様 (RINGDOM)

## ゴール
評価履歴を横断分析し、繰り返し発生している判断ミス(=リーク)をAIが3〜5個抽出して構造化表示する。Pro課金の柱になる機能。

## 前提・制約
- アプリは `index.html` 1ファイル(現在4813行)＋ `/api/*.js` Edge Functions の構成
- ビルドツールなし、依存追加は最小限。**Vite等の導入は禁止** — 既存と同じ素のHTML/JSで書く
- バックエンドはVercel Edge Functions
- スタイル変数は既存CSS変数を流用 (`--gold:#c9a227`, `--green-dark:#060e06`, `--green-mid:#0a1a0a` 等)
- 言語: 日本語UI

## スコープ

### MVP に含める
- 新エンドポイント `/api/leak-analyze.js` (Anthropic API プロキシ + IPレート制限)
- フロントの新パネル `panel-leak` (リーク分析画面)
- ハンバーガーメニューに「リーク分析」エントリ追加
- 評価履歴リスト上部にCTAボタン
- リーク分析結果のlocalStorage保存と再表示
- 履歴10件未満時のボタン無効化＋ガイダンス
- 結果からTOP3を切り出した縦長シェアカードのPNG出力 (html2canvas使用)
- JSON返却 + パース失敗時のテキストフォールバック

### MVP に**入れない** (将来)
- Pro/Free課金ゲート — β期間中は無制限で開放(ただしコードパスは残す)
- 前回分析との差分表示
- リーク改善トラッキング
- 該当ハンドの個別再評価

---

## 1. バックエンド: `/api/leak-analyze.js`

`/api/evaluate.js` の構造を踏襲。差分は以下:


```js
export const config = { runtime: 'edge' };

const ALLOWED_ORIGINS = [
  'https://ringdom.vercel.app',
  'http://localhost:3000',
];

// β期間中の簡易レート制限: 1 IP につき 1時間 5回まで
// Upstash Redis (Vercel marketplace で無料枠) を使う。なければ最小実装で in-memory はNG (Edge stateless)
import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';

const ratelimit = new Ratelimit({
  redis: Redis.fromEnv(),
  limiter: Ratelimit.slidingWindow(5, '1 h'),
  analytics: true,
});

export default async function handler(req) {
  const origin = req.headers.get('origin') || '';
  const isAllowed = ALLOWED_ORIGINS.includes(origin);

  if (req.method === 'OPTIONS') { /* 既存と同じCORS */ }
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  if (!isAllowed) return new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403 });

  // IPベース rate limit
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0] || 'unknown';
  const { success, remaining } = await ratelimit.limit(`leak:${ip}`);
  if (!success) {
    return new Response(JSON.stringify({ error: 'rate_limited', message: '少し時間を空けて再度お試しください' }), {
      status: 429,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': origin },
    });
  }

  try {
    const body = await req.json();
    const history = body.history || [];

    // 入力検証
    if (!Array.isArray(history) || history.length < 10) {
      return new Response(JSON.stringify({ error: 'insufficient_history' }), { status: 400 });
    }
    if (history.length > 30) history.length = 30; // 安全弁: 過大な入力を拒否

    // ログ
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
```



`package.json` に依存追加:

```json
{
  "dependencies": {
    "@upstash/ratelimit": "^2.0.0",
    "@upstash/redis": "^1.34.0"
  }
}
```



環境変数 (Vercel Dashboard で設定):
- `UPSTASH_REDIS_REST_URL`
- `UPSTASH_REDIS_REST_TOKEN`

(Vercel Marketplace から Upstash 連携すれば自動で入る)

---

## 2. フロント: 新パネル `panel-leak`

### 2-1. HTML構造を index.html に追加

`panel-eq` の直後あたりに追記:


```html
<div class="panel" id="panel-leak" style="position:fixed;top:0;left:0;right:0;bottom:0;background:var(--green-dark);padding:12px 14px 20px;overflow-y:auto;z-index:10;display:none">
  <div style="margin:0 0 12px">
    <button onclick="switchTab('log')" style="padding:6px 12px;border-radius:6px;font-size:11px;font-weight:700;font-family:inherit;cursor:pointer;background:transparent;color:var(--gold);border:1px solid var(--gold-dim);display:flex;align-items:center;gap:5px">
      <span style="font-size:14px">←</span> ログに戻る
    </button>
  </div>
  <div style="font-size:18px;font-weight:800;color:var(--gold);letter-spacing:2px;margin-bottom:4px">📊 リーク分析</div>
  <div style="font-size:11px;color:var(--text-dim);margin-bottom:16px">評価履歴から繰り返している判断ミスを抽出</div>

  <div id="leak-content"><!-- JSで描画 --></div>
</div>
```



### 2-2. ハンバーガーメニューに導線追加

既存ハンバーガーパネル(`hamburger-panel`)内、レンジ表/エクイティ計算と同じパターンで:


```html
<div onclick="openLeakFromMenu()" style="...同じスタイル...">
  📊 リーク分析
</div>
```



### 2-3. 評価履歴リスト上にCTA追加

`renderEvalHistory()` ([index.html:4737](index.html:4737)) の冒頭、履歴リストの直前に挿入:


```html
<button id="leak-cta-btn" onclick="openLeakAnalysis()" style="width:100%;padding:12px;border-radius:10px;font-size:13px;font-weight:700;font-family:inherit;cursor:pointer;background:linear-gradient(135deg,#c9a227,#7a6010);color:#0a1a0a;border:none;margin-bottom:12px;display:flex;align-items:center;justify-content:center;gap:8px">
  📊 これまでの評価からリーク分析
</button>
```



履歴件数 < 10 の場合はボタンを `disabled` 風に変え、テキストを「あと N件評価するとリーク分析が使えます」に。

---

## 3. JS実装 (index.html `<script>` 末尾付近)

### 3-1. 状態管理


```js
const LEAK_MIN_HISTORY = 10;
const LEAK_MAX_INPUT = 30;
const LEAK_RESULT_KEY = 'ringdom_leak_result';

function loadLeakResult() {
  try { return JSON.parse(localStorage.getItem(LEAK_RESULT_KEY) || 'null'); }
  catch { return null; }
}
function saveLeakResult(result) {
  try { localStorage.setItem(LEAK_RESULT_KEY, JSON.stringify({ ...result, ts: Date.now() })); }
  catch {}
}
```



### 3-2. 実行関数


```js
async function openLeakAnalysis() {
  switchTab('leak');
  renderLeakPanel();
}

function openLeakFromMenu() {
  closeHamburger();
  setTimeout(() => openLeakAnalysis(), 250);
}

async function runLeakAnalysis() {
  const history = loadEvalHistory();
  if (history.length < LEAK_MIN_HISTORY) return;

  const input = history.slice(0, LEAK_MAX_INPUT); // 新しい順を渡す前提なら .reverse() 検討
  
  document.getElementById('leak-content').innerHTML = `
    <div style="text-align:center;padding:40px 0;color:var(--text-dim)">
      <div class="eval-spinner" style="margin:0 auto 12px"></div>
      AI分析中... (最大30秒)
    </div>`;

  try {
    const res = await fetch('/api/leak-analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ history: input }),
    });
    if (res.status === 429) {
      renderLeakError('しばらく時間を空けて再度お試しください(レート制限)');
      return;
    }
    const data = await res.json();
    const text = data?.content?.[0]?.text || '';
    
    // JSONパース (Claudeが余計な文字を付けた場合に備え抽出)
    let result = null;
    try {
      result = JSON.parse(text);
    } catch {
      const match = text.match(/\{[\s\S]*\}/);
      if (match) try { result = JSON.parse(match[0]); } catch {}
    }
    
    if (!result || !Array.isArray(result.leaks)) {
      renderLeakFallback(text); // 生テキスト表示
      return;
    }
    
    saveLeakResult(result);
    renderLeakResult(result);
  } catch (e) {
    renderLeakError('分析に失敗しました: ' + e.message);
  }
}
```



### 3-3. 描画


```js
function renderLeakPanel() {
  const history = loadEvalHistory();
  const cached = loadLeakResult();
  const el = document.getElementById('leak-content');

  if (history.length < LEAK_MIN_HISTORY) {
    el.innerHTML = `
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:24px;text-align:center">
        <div style="font-size:14px;color:var(--text);margin-bottom:8px">あと ${LEAK_MIN_HISTORY - history.length}件 で利用できます</div>
        <div style="font-size:11px;color:var(--text-dim)">現在 ${history.length}/${LEAK_MIN_HISTORY}件</div>
      </div>`;
    return;
  }

  const lastTs = cached?.ts ? new Date(cached.ts) : null;
  const lastStr = lastTs ? `前回の分析: ${lastTs.getMonth()+1}/${lastTs.getDate()} ${String(lastTs.getHours()).padStart(2,'0')}:${String(lastTs.getMinutes()).padStart(2,'0')}` : '';

  el.innerHTML = `
    <button onclick="runLeakAnalysis()" style="width:100%;padding:14px;border-radius:10px;font-size:14px;font-weight:700;font-family:inherit;cursor:pointer;background:#c9a227;color:#0a1a0a;border:none;margin-bottom:8px">
      ${cached ? '🔄 再分析する' : '📊 分析を開始'}
    </button>
    ${lastStr ? `<div style="font-size:10px;color:var(--text-muted);text-align:center;margin-bottom:16px">${lastStr}</div>` : ''}
    ${cached ? renderLeakResultHTML(cached) : ''}
  `;
}

function renderLeakResult(result) {
  document.getElementById('leak-content').innerHTML = `
    <button onclick="runLeakAnalysis()" style="...再分析ボタン...">🔄 再分析する</button>
    ${renderLeakResultHTML(result)}
  `;
}

function renderLeakResultHTML(result) {
  const sevColor = { high: '#f87171', medium: '#FBBF24', low: '#4ade80' };
  const sevLabel = { high: '重要', medium: '中', low: '軽微' };
  
  return `
    <div style="background:var(--surface);border:1px solid var(--gold-dim);border-radius:12px;padding:16px;margin-bottom:16px">
      <div style="font-size:10px;color:var(--gold);letter-spacing:2px;margin-bottom:8px">SUMMARY</div>
      <div style="font-size:13px;color:var(--text);line-height:1.7">${escapeHtml(result.summary)}</div>
    </div>

    ${result.leaks.map((leak, i) => `
      <div style="background:var(--surface);border:1px solid var(--border);border-left:3px solid ${sevColor[leak.severity]};border-radius:8px;padding:14px;margin-bottom:10px">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
          <div style="font-size:14px;font-weight:800;color:var(--text)">${i+1}. ${escapeHtml(leak.title)}</div>
          <div style="font-size:9px;font-weight:700;color:${sevColor[leak.severity]};padding:2px 8px;border:1px solid ${sevColor[leak.severity]};border-radius:10px">${sevLabel[leak.severity]}</div>
        </div>
        <div style="font-size:10px;color:var(--text-muted);margin-bottom:8px">${escapeHtml(leak.frequency)}</div>
        <div style="font-size:12px;color:var(--text-dim);line-height:1.7;margin-bottom:10px">${escapeHtml(leak.pattern)}</div>
        <div style="background:#0d1a0d;border-radius:6px;padding:10px">
          <div style="font-size:10px;color:var(--accent);font-weight:700;margin-bottom:4px">→ 改善案</div>
          <div style="font-size:12px;color:var(--text);line-height:1.7">${escapeHtml(leak.fix)}</div>
        </div>
      </div>
    `).join('')}

    ${result.strength ? `
      <div style="background:#0d1a2a;border:1px solid #1e3a5f;border-radius:8px;padding:14px;margin-bottom:16px">
        <div style="font-size:10px;color:#60A5FA;font-weight:700;margin-bottom:4px">✓ 良い点</div>
        <div style="font-size:12px;color:var(--text);line-height:1.7">${escapeHtml(result.strength)}</div>
      </div>` : ''}

    <button onclick="exportLeakCard()" style="width:100%;padding:13px;border-radius:10px;font-size:13px;font-weight:700;font-family:inherit;cursor:pointer;background:transparent;color:var(--gold);border:1px solid var(--gold);margin-bottom:8px">
      📷 シェア用カードを保存
    </button>
  `;
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

function renderLeakError(msg) {
  document.getElementById('leak-content').innerHTML = `
    <div style="background:#2a0d0d;border:1px solid #5c1a1a;border-radius:8px;padding:14px;color:#f87171;font-size:12px">${escapeHtml(msg)}</div>
    <button onclick="renderLeakPanel()" style="...">戻る</button>`;
}

function renderLeakFallback(rawText) {
  document.getElementById('leak-content').innerHTML = `
    <div style="background:#2a1f0d;border:1px solid #5c4a1a;border-radius:8px;padding:14px;color:#FBBF24;font-size:11px;margin-bottom:12px">
      ⚠ 構造化失敗のため生テキスト表示
    </div>
    <div style="background:var(--surface);padding:14px;border-radius:8px;font-size:12px;color:var(--text);line-height:1.7;white-space:pre-wrap">${escapeHtml(rawText)}</div>`;
}
```



### 3-4. switchTab に `'leak'` を追加

[index.html:2883](index.html:2883) `switchTab(tab)` 関数の panel 切替ロジックに `panel-leak` を加える(`panel-eq` と同じ全画面オーバーレイ扱い)。

---

## 4. シェア用縦長カード (TOP3)

### 4-1. html2canvas を CDN で読み込む

`<head>` に追加:

```html
<script src="https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js" defer></script>
```



### 4-2. オフスクリーンに専用DOMを生成してキャプチャ


```js
async function exportLeakCard() {
  const result = loadLeakResult();
  if (!result) return;
  
  const top3 = result.leaks.slice(0, 3);
  
  const card = document.createElement('div');
  card.style.cssText = `
    position:fixed;left:-9999px;top:0;
    width:1080px;height:1920px;
    background:linear-gradient(180deg,#060e06 0%,#0d2210 100%);
    color:#d4e8d4;font-family:'DM Sans',sans-serif;
    padding:80px 60px;box-sizing:border-box;
    display:flex;flex-direction:column;
  `;
  
  const sevColor = { high: '#f87171', medium: '#FBBF24', low: '#4ade80' };
  
  card.innerHTML = `
    <div style="text-align:center;margin-bottom:60px">
      <div style="font-size:52px;font-weight:900;color:#c9a227;letter-spacing:8px">♠ RINGDOM</div>
      <div style="font-size:24px;color:#7a9a7a;letter-spacing:4px;margin-top:12px">MY LEAKS — TOP 3</div>
    </div>

    ${top3.map((leak, i) => `
      <div style="background:rgba(13,31,13,0.8);border:2px solid ${sevColor[leak.severity]};border-radius:24px;padding:40px;margin-bottom:32px;flex:1">
        <div style="display:flex;align-items:center;gap:16px;margin-bottom:20px">
          <div style="font-size:56px;font-weight:900;color:#c9a227;line-height:1">#${i+1}</div>
          <div style="font-size:36px;font-weight:800;color:#fff;flex:1">${escapeHtml(leak.title)}</div>
        </div>
        <div style="font-size:22px;color:#a0c0a0;line-height:1.7;margin-bottom:20px">${escapeHtml(leak.pattern)}</div>
        <div style="background:#0d1a0d;border-radius:12px;padding:20px">
          <div style="font-size:18px;color:#4ade80;font-weight:700;margin-bottom:8px">→ 改善案</div>
          <div style="font-size:22px;color:#d4e8d4;line-height:1.7">${escapeHtml(leak.fix)}</div>
        </div>
      </div>
    `).join('')}

    <div style="text-align:center;margin-top:40px;font-size:20px;color:#7a6010;letter-spacing:3px">
      ringdom.vercel.app
    </div>
  `;
  
  document.body.appendChild(card);
  try {
    const canvas = await html2canvas(card, { backgroundColor: null, scale: 1 });
    const a = document.createElement('a');
    a.download = `ringdom_leaks_${Date.now()}.png`;
    a.href = canvas.toDataURL('image/png');
    a.click();
  } finally {
    document.body.removeChild(card);
  }
}
```


---

## 5. 受け入れ条件 (PR レビュー時の確認項目)

- [ ] 履歴 < 10件 で CTA ボタンが無効化され、残り件数が表示される
- [ ] 履歴 ≥ 10件 でボタン押下 → API 呼ばれ、JSON が返り、構造化UI で表示される
- [ ] レスポンスが JSON パース失敗した場合、生テキストでフォールバック表示される
- [ ] 結果が `ringdom_leak_result` に保存され、再訪時に表示される
- [ ] 「再分析する」ボタンで上書き再生成できる
- [ ] 「シェア用カードを保存」で 1080×1920 の PNG がダウンロードされる
- [ ] サーバ側 IP rate limit が動作する (1時間5回)
- [ ] 429時にユーザーフレンドリーなメッセージが出る
- [ ] レスポンスのリーク数が3〜5、severity と examples が含まれている (実機確認)
- [ ] エラー時にスタックトレースをユーザーに見せない

## 6. コスト見積もり (参考)

- 1分析あたり: 入力≒18kトークン + 出力≒1.5kトークン
- Sonnet 4.6 $3/$15 per M tokens で **約$0.077 / 回**
- 月100ユーザー × 月3回 = **約$23/月** (β中の規模)

---

## 7. 開始前のお願い

1. このファイルを `docs/leak-analysis-spec.md` として repo にコミット
2. Plan Mode (Shift+Tab) で実装計画を出してもらってから着手
3. PR作成前に `/security-review` を1回かける(API キー扱い、XSS、CORS の確認)
