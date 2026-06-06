# ストア用スクリーンショット

ここにあるのは**サンプル**（実機/エミュレータで撮影した実画面）です。提出時はこれを土台に、必要なら見出しコピー（`store-listing.md`§9）を重ねて仕上げてください。

| ファイル | 内容 | 撮影元 |
|---|---|---|
| 01-onboarding-ios.png | オンボーディング | iOS Simulator (iPhone 17) |
| 02-playlog-android.png | プレイログ（ハンド入力） | Android Emulator (Pixel 7) |
| 03-ai-eval-android.png | AI評価結果（★5「教科書的オープン」） | Android Emulator |

## ✅ 提出用（見出し付き・1080×1920）
`store/` に**そのままアップロードできる**仕上げ済みスクショを置いています（深緑背景＋ゴールド見出し＋フレーム）。
- `store/01-feature-onboarding.png` … 「評価が貯まるほど、弱点が見えてくる」
- `store/02-feature-input.png` … 「プレイ後に入力するだけ」
- `store/03-feature-ai-eval.png` … 「AIがEV目線で添削」
- `store/04-feature-range.png` … 「レンジ表も内蔵」

> 再生成スクリプト：`/tmp/gen_shots.js`（素材PNG＋見出しを Chrome で合成）。追加カット（リーク分析・エクイティ）も同方式で作成可。

## ✅ App Store 用（1320×2868 = 6.9インチ）
`store-ios/` に App Store Connect へそのままアップロードできる4枚（オンボーディングは実iOSキャプチャ）。
- `store-ios/01-onboarding.png` / `02-input.png` / `03-ai-eval.png` / `04-range.png`
> 再生成：`/tmp/gen_ios.js`。1290×2796 が必要な場合は window-size を変更して再レンダリング。

## ストアが要求する主なサイズ
- **App Store**：6.9インチ（1290×2796）必須。6.5インチ等は任意。最低1枚、最大10枚。
  - 追加で撮るなら `iPhone 16 Pro Max` 等のシミュレータで撮影すると 1290×2796 になります。
- **Google Play**：携帯電話用スクショ 最低2枚（16:9 か 9:16、各辺 320〜3840px）。フィーチャーグラフィック 1024×500 が別途必須。

## 追加で撮ると良いカット
- リーク分析画面（AI評価を10件貯めると解放）
- エクイティ計算機 / レンジ表
- プレイヤー帳

## 撮り方（コマンド）
```bash
# iOS（起動中シミュレータ）
xcrun simctl io booted screenshot ~/Desktop/shot.png
# Android（起動中エミュレータ）
~/Library/Android/sdk/platform-tools/adb exec-out screencap -p > ~/Desktop/shot.png
```
