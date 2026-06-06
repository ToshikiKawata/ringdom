# RINGDOM リリース手順書（ストア提出 完全ガイド）

このドキュメントは「起きたらこの通りに進めれば提出まで行ける」ことを目的にしています。
コード側（Capacitor / アイコン / プライバシーポリシー / 掲載文）は**すべて準備済み**です。
残るのは、**あなたの開発者アカウントとお金が必要な操作**だけです。

掲載文・審査メモ・年齢区分の回答は `docs/store-listing.md` にコピペ用で揃えてあります。

---

## 0. 全体像（残りやること）

| | やること | 費用 | 所要 |
|---|---|---|---|
| 共通 | 開発者アカウント登録 | Apple 年$99 / Google $25(買切) | 各 30分〜（Appleは承認に数日かかる場合あり） |
| Android | 署名付き AAB を作成 → Play Console にアップロード | 0 | 1〜2時間 |
| iOS | Xcodeでアーカイブ → App Store Connect にアップロード | 0 | 1〜2時間 |
| 共通 | 掲載文・スクショ・年齢区分・審査メモを入力して提出 | 0 | 各 30〜60分 |

> おすすめは **Android（内部テスト）から**。審査が速く・安く・落ちにくいので、最初の一本に向いています。

---

## 1. ビルド前の共通おまじない

ネイティブに最新のWeb資産を反映してから各ビルドを行います。プロジェクト直下で：

```bash
cd ~/Documents/dev/ringdom
npm run sync
```

（`www/` を作り直し、iOS/Android に同期します。コード変更後は毎回これ）

---

## 2. Android：Google Play へ

### 2-1. Google Play デベロッパー登録
1. https://play.google.com/console に Googleアカウントでアクセス
2. デベロッパー登録（$25・一度きり）。本人確認あり。

### 2-2. 署名付き AAB（Android App Bundle）を作る
Play ストアは **署名鍵（keystore）** が必須です。**Android Studio の GUI が一番簡単**です。

1. Android Studio を開く：
   ```bash
   npm run open:android
   ```
2. メニュー **Build > Generate Signed App Bundle / APK** を選択
3. **Android App Bundle** を選んで Next
4. **Create new…**（鍵を新規作成）を押し、以下を入力：
   - Key store path：`~/ringdom-release.jks`（**iCloudやパスワードマネージャに必ずバックアップ**。失うと二度とアプリ更新できません）
   - パスワード（store/key）：強固なものを設定し、安全に保管
   - alias：`ringdom`
   - 有効期間：25年以上、名前など適当でOK
5. Next →ビルドタイプ **release** を選択 → Finish
6. 出力先（`android/app/release/app-release.aab` など）に `.aab` ができる

> ※ 「Play App Signing」（Googleが本番鍵を管理）はアップロード時に自動で有効になります。あなたが作るのは“アップロード鍵”という位置づけでOK。

### 2-3. Play Console でアプリ作成 → 提出
1. Play Console で「アプリを作成」：名前 **RINGDOM**、無料、デフォルト言語=日本語
2. 左メニューを順に埋める（`docs/store-listing.md` からコピペ）：
   - **ストアの掲載情報**：短い説明 / 詳しい説明 / アイコン(512px=`icons/icon-512.png`) / フィーチャーグラフィック(1024×500・要作成) / スクショ
   - **コンテンツのレーティング**：アンケートに回答（ギャンブル＝「実通貨の賭けなし/シミュレーテッドギャンブルなし」。`store-listing.md`§5参照）
   - **データセーフティ**：`store-listing.md`§8 の通り
   - **プライバシーポリシー**：`https://ringdom.vercel.app/privacy.html`
   - **広告**：「広告は含まない」
3. **リリース > テスト > 内部テスト** で新規リリースを作成 → 2-2 の `.aab` をアップロード
4. テスター（自分のGmail）を登録 → 公開 → 数十分で自分の端末にインストール可能
5. 問題なければ **製品版** トラックへ昇格して審査提出

---

## 3. iOS：App Store へ

### 3-1. Apple Developer Program 登録
1. https://developer.apple.com/programs/ で登録（年$99）。承認に数時間〜数日。

### 3-2. Xcode で署名設定
```bash
npm run open:ios   # Xcode が開く
```
1. 左の **App** ターゲット > **Signing & Capabilities**
2. **Automatically manage signing** にチェック
3. **Team** に自分の Apple Developer アカウントを選択
4. **Bundle Identifier** が `app.ringdom.poker` になっているか確認

### 3-3. アーカイブ → アップロード
1. 上部のデバイス選択を **Any iOS Device (arm64)** にする
2. メニュー **Product > Archive**
3. 完了後の Organizer で **Distribute App > App Store Connect > Upload**

> ⚠️ もし署名時に `resource fork, Finder information, or similar detritus not allowed` が出たら（macOSの拡張属性が原因）、ターミナルで以下を実行してから再アーカイブ：
> ```bash
> cd ~/Documents/dev/ringdom && xattr -cr ios/App/App/public ios/App/App/Assets.xcassets
> ```
> （今回の開発環境特有の `com.apple.provenance` 由来。あなたの環境では出ない可能性が高いです）

### 3-4. App Store Connect で情報入力 → 提出
1. https://appstoreconnect.apple.com で「新規アプリ」：名前 **RINGDOM**、Bundle ID=`app.ringdom.poker`、SKU=`ringdom`
2. `docs/store-listing.md` から：サブタイトル / プロモーション文 / 説明 / キーワード / サポートURL / プライバシーURL
3. **スクリーンショット**（`docs/screenshots/` 参照）をアップロード
4. **年齢制限**：`store-listing.md`§5 の通り回答
5. **App Privacy**：`store-listing.md`§7 の通り
6. **App Review Information > Notes**：`store-listing.md`§6 の審査メモ（英文）を貼る ← **ギャンブル誤判定対策の最重要項目**
7. TestFlight で自分で動作確認 → 「審査へ提出」

---

## 4. 提出前 最終チェックリスト

- [ ] `npm run sync` 済み（最新Webを同梱）
- [ ] アプリが実機/シミュレータ/エミュレータで起動し、AI評価が返る（Wi-Fi接続時）
- [ ] プライバシーポリシーが https://ringdom.vercel.app/privacy.html で開ける
- [ ] 審査メモ（ギャンブルではなく学習ツール）を両ストアに記載
- [ ] 年齢区分・データ申告を `store-listing.md` 通りに回答
- [ ] スクショを各サイズで用意
- [ ] （Android）keystore を安全にバックアップした

---

## 5. 覚えておくと便利なコマンド

```bash
npm run sync          # www再生成 + iOS/Android同期（コード変更後は毎回）
npm run open:ios      # Xcode を開く
npm run open:android  # Android Studio を開く
npm run assets        # アイコン/スプラッシュを再生成（icons/icon.svg, assets/splash.svg から）
```

アプリのコードを直したら：`index.html` を編集 → `npm run sync` → 各ストアのビルドをやり直し。

---

## 6. v1 以降のメモ
- v1 は **無料・アプリ内課金なし**（決済未実装のため、ネイティブでは課金UIを非表示＆AI評価は無制限）。
- 将来 Pro 課金を入れる場合は **RevenueCat**（Apple/Google の課金を1SDKで扱える）で後付けが定石。
- アプリ名は **RINGDOM** を維持。AI訴求はサブタイトルで（`RING-GPT` 等は審査/商標/「中身はClaude」の点でNG）。
