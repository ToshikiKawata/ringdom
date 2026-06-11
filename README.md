# RINGDOM ♠

**ポーカーの判断ミスを、AIが添削する。** プレイ後にハンドを入力すると Claude が★1〜5で評価し、記録が貯まるほど自分の弱点 (リーク) が見えてくるポーカー上達ログ。

🃏 **アプリ**: https://ringdom.vercel.app (Web/PWA ─ iOS/Android はストア申請準備中)

## 主な機能

- **AI評価** ─ ハンド・ボード・アクションを入力すると、EV影響と代替案つきで添削
- **リーク分析** ─ 評価が10件貯まると解放。繰り返している悪いクセをAIが横断抽出
- **補助ツール** ─ レンジ表 / エクイティ計算 / プレイヤー帳

## アーキテクチャ

単一の `index.html` (vanilla JS) を Web・iOS・Android (Capacitor) で共有し、Vercel Edge Functions 経由で Claude API を呼ぶ構成。

**→ [システム構成図と設計判断](docs/architecture/README.md)**

![システム構成図](docs/architecture/architecture.png)

## 開発

```bash
npm install
npm run sync      # www/ を生成して iOS / Android へ反映
npm run open:ios  # Xcode を開く
npm run open:android
```

リリース手順は [docs/RELEASE-GUIDE.md](docs/RELEASE-GUIDE.md)、ストア掲載文は [docs/store-listing.md](docs/store-listing.md) を参照。
