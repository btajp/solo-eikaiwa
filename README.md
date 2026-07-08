# solo-eikaiwa

毎日5分から回せる、自分専用の英会話ジム。録音した声をローカルで文字起こしし、AIが会話相手とコーチを務め、練習履歴が貯まっていく — すべて自分の Mac の上で。
A local-first, research-grounded English speaking practice app for daily self-study on macOS.

個人開発のツールを公開しているものです。Issue / PR は歓迎しますが、対応は保証しません。

## できること

### 🔊 クイックドリル（5〜10分）— 毎日のメイン

1日1本、5〜10分で終わる単品ドリル。研究上、総学習時間より「頻度と完了」が上達に効くため、これが日々のデフォルト導線です。

- **音読ウォームアップ（6分）** — 今日のお題の表現チャンクを声に出して準備。各表現は🔊ボタンでネイティブ音声を聞ける
- **くり返しトーク 4/3/2（8分）** — 同じ話を制限時間を縮めながら2回話す流暢性トレーニング。話す前に「表現・話の骨組み・モデルトーク」の準備フェーズがあり、ラウンド間には AI が言い間違いを日本語で解説
- **ロールプレイ（10分・日常/ビジネス/IT の3種）** — レストランや旅行、会議や日程調整、障害対応やベンダー対応など、選んだ場面のシナリオで AI と役割練習
- **シャドーイング（5分）** — AI が生成した短いモデルトークに重ねて発話。「日本語訳と解説」ボタンで全文訳と表現ポイントも確認できる

### 📋 強化セッション（60分 / 30分・週1〜2回）

音読ウォームアップ → 4/3/2 → ロールプレイ → シャドーイング → 振り返り、の5ブロック通し練習。振り返りでは今日の発話から AI が改善ポイントをまとめます。

### 💬 自由会話

英語でただ話す。録音ボタンを押して話すと、ローカルで文字起こしされ、AI が音声で返してきます。

### 📖 暗記例文390

会話でそのまま使える文法・言い回しを網羅したオリジナル390文。文法・機能25分類（日常/ビジネス/IT）に加えて、依頼・断り・聞き返し・言い換え・相槌という5つの会話機能を、難易度帯（入門/中級/上級）ごとに30文ずつ収録しています。**日本語を見て声に出す → 答え合わせ（音声つき）→ 3段階の自己評価**という産出リトリーバル型で、評価に応じて 1→3→7→14→30→60日 の間隔反復（SRS）が次の出題日を決めます。一覧モードでは全文をフィルタ・音声つきで眺められます。

390文すべての音声はリポジトリに同梱済み（`content/sentences/audio/`、OpenAI TTS で事前生成したAI音声）なので、**OpenAI キーなしでもネイティブ品質の音声で練習できます**。

### 🎧 リスニング（多聴）

レベルに合った短い英語を、スクリプトを隠したまま通しで聴くリスニング練習。3つのレベル帯（入門/中級/上級）× 3ドメイン（日常/ビジネス/IT）で均等に用意した42本（各2〜4分）を収録し、音声はすべてリポジトリに同梱済み（OpenAI TTS で事前生成）。聴き終えたらボタンでスクリプト表示・日本語訳と表現解説も確認できます。聴いた本数は「今週◯本」の情報表示のみでノルマはありません。素材は生成CLIで自分のレベルに合わせてさらに増やせます。

### 🪜 教材ラダー（全レベル帯×全ドメインの事前生成）

お題62本・ロールプレイシナリオ45本・多聴42本は、いずれも3つのレベル帯（入門/中級/上級）× 3ドメイン（日常/ビジネス/IT）で均等本数を満たすように用意されています（帯適合の主要教材がお題36本・シナリオ27本・多聴36本、残りは複数帯にまたがる資産として温存）。カバレッジは `bun scripts/check-content-coverage.ts` で機械検証でき、不足があれば非ゼロ終了します。

4/3/2 の準備チャンク（prepPack）とモデルトーク（シャドーイング用のお手本音声）も、対象36お題×帯内2stage分＝72通りを事前生成して同梱済み（`content/topic-assets/`・モデルトークは音声も同梱。準備チャンクの音声は再生時にその場で合成しローカルにキャッシュ）。実行時はこの同梱データ → DBキャッシュ → その場での生成、の順に解決するため、レベルが上がって新しいお題に切り替わっても待ち時間が発生しにくくなっています。生成教材はすべて機械検証（話し言葉として自然か・完全文か等）を経て同梱しており、検証NGの生成物は手で直さず再生成しています。

教材の在庫状況により、選んだドメインの教材が無く別ドメインへ振り替わったり、レベル帯にちょうど合う教材が無く帯を跨いで出題されたりしたときは、練習画面に「近いレベルの教材を選びました」という一言が表示されます（学習の進行を妨げない情報表示のみで、警告やペナルティではありません）。

### 📐 レベルとプレースメント

練習の難易度はレベル（Lv1〜、上限なし）が駆動します。4/3/2 の持ち時間、モデルトーク・準備チャンク・言い直し例の語彙と構文（入門帯は A2・短文中心）、お題の帯域がレベルに応じてなだらかに変化し、ブロック完了や例文の自己評価で貯まる XP がレベルを押し上げます。ステージ境界（Lv10/20/…）だけは自動で跨がず、実績（練習日数・完了率）を根拠つきで提示して承認制で昇格します。降格も「調整の提案」としてのみ出ます — 完了率や中断だけでなく「時間はかけたのに発話が伸びない」実測シグナルも材料にしつつ、XP は減らず、自動降格もありません（動機づけ研究の知見に沿った情報的フィードバック設計です）。各練習画面には難易度の実態チップ（「Lvに自動調整」「Lv帯で選ぶ」「全レベル共通」）が表示されます。

初回は**レベル測定（約10分）**がおすすめ: 自己紹介 → 状況説明 → 意見の3タスクを録音すると、CEFR 記述子ベースのルーブリックで開始レベルが提示されます（反映するかはあなたが決めます）。以後は30日ごとに月次測定の導線が出て、話す力の変化を定点観測できます。

30日ごとに Progress 画面で**月次レビュー**も書いてもらえます。直近30日の練習時間・調音速度・例文の定着・収集チャンクなどをまとめた日本語の振り返りレポートです（情報表示のみ・ノルマや判定はありません）。

### 📚 ライブラリと練習記録

- 生成されたモデルトークは自動でライブラリに保存され、あとから本文確認・再再生できる
- ホームの GitHub 風カレンダー（その日に得た XP に応じて草の色が濃くなる5段階表示。例文の自己評価だけの日にも草が生えます）と練習記録（今週◯日・累計◯日）で継続が見える。連続日数を煽る演出は意図的に置いていません（切れたときのモチベーション低下が研究で示されているため）
- **練習フィードバック**: セッション完了・自由会話・多聴の後に「今のはどうでしたか？（キツい/ちょうどいい/簡単 + 任意メモ）」の1タップ評価。溜まった記録は「フィードバック」画面で一覧・Markdown コピーでき、アプリ改善の入力に使えます（タップしなければ何も起きません）
- サイドバーは**今日の練習 / 自主練 / 記録・測定**の3セクション構成。自主練の取り組み順ヒント（聞く→覚える→話す）を ⓘ で確認できます。「記録・測定」の **⚙️ 設定**で LLM プロバイダ（用途別ルーティング・ロール別のモデル/effortチューニング・実効モデルの可視化・認証モード〔サブスク/APIキー〕選択・課金先を選ぶ優先クラウドを含む・後述）と文字サイズ・言語を変更できます。
- UI はデフォルト英語。**⚙️ 設定 → 表示**または**サイドバー下部のトグル**で、**EN / 日本語**と文字サイズをいつでも切り替え可能
- サイドバー最下部の **GitHub アイコン**と**このアプリについて**から、リポジトリと紹介ページ（LP）へ移動できます

### 🖥️ デスクトップアプリ（Tauri・実験的）

ブラウザだけでなく、ネイティブウィンドウ（Tauri v2・macOS・実験的）からもアプリを開けます。サーバさえ起動していれば、Caddy 無しでも `http://127.0.0.1:3111` をブラウザで直接開くだけで使えます（従来の Caddy/https 運用はそのまま併存・任意）。デスクトップアプリの詳しい説明は後述「起動: デスクトップアプリ（Tauri・実験的）」を参照してください。

## 学習設計の根拠

セッション構成は思いつきではなく、第二言語習得（SLA）研究のメタ分析・原典を3票の敵対的検証にかけた[リサーチレポート3本](docs/research/)に基づいています。核になっている知見:

- **4/3/2 時間圧反復**が発話速度・流暢性を向上させる（準備フェーズと明示的フィードバックの併用でさらに効果）
- **産出リトリーバル**（思い出して口に出す）は受容型学習より記憶定着に有効
- **間隔反復**は複雑なアルゴリズム不要。長めの固定間隔で十分
- **頻度 > 総時間**。1日サボっても無害、1週間空くと有害 — だから「短くても毎日」

詳細は[設計ドキュメント](docs/superpowers/specs/2026-07-05-learn-english-system-design.md) §5（方法論10原則）へ。

## 仕組みとプライバシー

```
ブラウザ録音 → whisper.cpp（ローカルSTT） → Claude（会話相手・コーチ） → OpenAI 互換 TTS（既定は OpenAI・ローカル TTS に差し替え可／なければ macOS say）
```

- **音声はマシンから出ません**。外部に送られるのは発話のテキスト（Claude へ）と AI 応答のテキスト（TTS 用・OpenAI 利用時のみ外部送信。TTS を**ローカルサーバ**に向ければ音声テキストも外部に出ません）だけ
- 学習データ（録音・トランスクリプト・進捗・SRS状態・キャッシュ）はすべて `data/` のローカルファイルで、**リポジトリには一切コミットされない**
- API サーバは 127.0.0.1 バインドのみ（外部非公開）
- 対話 AI は Claude Agent SDK 経由であなたの Claude Pro/Max サブスクリプションを使うため、**Anthropic API キーは不要**

## はじめる

### 前提条件

- macOS（Apple Silicon 推奨）
- [Bun](https://bun.sh) ≥ 1.3
- Homebrew（whisper-cpp / ffmpeg の導入に使用）
- [Claude Code](https://claude.com/claude-code) CLI にログイン済みであること（既定の LLM。Ollama 等のローカル LLM や Codex への切替は「LLM プロバイダの切替」参照）
- 任意: 高品質TTS。OpenAI API キー（`OPENAI_API_KEY`）を使うか、ローカル TTS（kokoro-fastapi 等・後述）に向ける。どちらも無ければ macOS `say` で動作
- Chrome 系ブラウザ推奨（録音が audio/webm 固定のため。Safari 非対応）

### セットアップ（初回のみ）

```bash
./scripts/setup.sh   # brew 依存・whisperモデル(約1.6GB)DL・bun install
```

任意で `app/.env` に OpenAI キーを設定（環境変数参照も可）:

```
OPENAI_API_KEY=$YOUR_OPENAI_KEY_ENV_VAR
```

TTS を OpenAI 以外（ローカル等）に向けるときは `app/.env` に次を追加できます（すべて任意・未設定なら既定の OpenAI/say）:

```
TTS_BASE_URL=http://localhost:8880/v1   # OpenAI 互換の音声エンドポイント
TTS_MODEL=kokoro                        # サーバが受け付けるモデル名
TTS_VOICE=af_sky                        # サーバが受け付ける voice
# TTS_API_KEY=...                       # 鍵が要るエンドポイントのみ（未指定なら OPENAI_API_KEY にフォールバック）
```

同じ項目は「⚙️ 設定 → モデル接続設定」（音声/TTS の設定はモデル接続設定タブ内に統合済み）からも変更でき、DB 設定が env を上書きします。

### 起動: 常駐（推奨）

2つの常駐プロセスで動きます。**API サーバ**（launchd の LaunchAgent・ポート3111）と、任意で **Caddy**（https 化・`https://solo-eikaiwa` ドメインでのアクセス用）です。**API サーバはクライアントの dist を直接配信するため、Caddy が無くても `http://127.0.0.1:3111` をブラウザで開くだけで使えます**（v0.27.0〜。従来の Caddy/https 運用は変更なくそのまま併存できます）。どちらの構成でもログイン時の自動起動・クラッシュ時の自動再起動が効きます。

**① API サーバの常駐**（このリポジトリのスクリプトで完結・これだけで `http://127.0.0.1:3111` が使えます）:

```bash
./scripts/install-daemon.sh   # クライアントビルド → LaunchAgent 登録 → ヘルスチェック
```

**② Caddy の用意（任意・https や `solo-eikaiwa` ドメインでアクセスしたい場合のみ）**。マシンごとに初回のみ。Homebrew の Caddy を常駐サービスにする例:

```bash
brew install caddy
# 1. このリポジトリの Caddyfile 内 root のパスを自分のチェックアウト先に合わせて編集
# 2. Homebrew の Caddyfile（/opt/homebrew/etc/Caddyfile）に import 行を追加:
#      import /path/to/solo-eikaiwa/Caddyfile
brew services start caddy    # ログイン時自動起動の常駐サービスとして登録
caddy trust                  # ローカルCA証明書をキーチェーンへ登録（初回のみ・要パスワード）
echo "127.0.0.1 solo-eikaiwa" | sudo tee -a /etc/hosts   # https://solo-eikaiwa 用
```

ブラウザで https://solo-eikaiwa を開く（hosts を編集しない場合は https://solo-eikaiwa.localhost — Chrome 系なら hosts 不要）。Caddy を用意しない場合は、ブラウザで `http://127.0.0.1:3111` を直接開いてください。

- 状態確認: `./scripts/status-daemon.sh` / 停止・解除: `./scripts/uninstall-daemon.sh`
- コードを更新したら `./scripts/install-daemon.sh` を再実行（再ビルド＋デーモン再起動が一括で済む）
- Caddyfile を変更したら Caddy に再読み込みさせる: brew services 構成なら `brew services restart caddy`、共有 Caddy デーモン構成なら `sudo launchctl kickstart -k system/com.local.https.caddy`
- Firefox で証明書警告が出る場合: `about:config` で `security.enterprise_roots.enabled` を `true` に（Firefox は macOS キーチェーンを標準では参照しないため）

### 起動: 開発

```bash
cd app && bun run dev        # APIサーバ :3111（127.0.0.1 のみ）
cd app/client && bun run dev # UI :5173（/api をプロキシ）
```

ブラウザで http://localhost:5173 を開く。常駐運用（https://solo-eikaiwa）とは独立して動きます。ポート3111は共用なので、常駐と開発サーバは同時に起動できません。

### 起動: デスクトップアプリ（Tauri・実験的）

サーバ（常駐 or 開発サーバ）が `http://127.0.0.1:3111` で動いていれば、ブラウザの代わりにネイティブウィンドウ（Tauri v2）からも同じアプリを開けます。Phase 1 はサーバへ「アタッチ」するだけの薄いシェルで、フロントエンドはバンドルせず、サーバの dist をそのまま表示します（挙動はブラウザ版と完全に同一）。**macOS（Apple Silicon で確認済み）のみ対応の実験的機能で、Windows/Linux は未検証です。**

- 起動時に `http://127.0.0.1:3111/api/health` をポーリングし、応答があれば本体 UI をそのまま表示、応答が無ければ「サーバ未起動」の案内ページ（日本語+英語・`./scripts/install-daemon.sh` の実行を促す文言・再試行ボタン付き）を表示します
- dev 起動・ビルド手順は [`desktop/README.md`](desktop/README.md) を参照してください（`cd desktop/src-tauri && cargo tauri dev` / `cargo tauri build --bundles app`）
- **初回のマイク許可は必ず Finder から `.app` をダブルクリックして起動して行ってください。** ターミナル経由（`open` 含む）で起動すると、macOS のマイク許可ダイアログの請求元表示が `solo-eikaiwa` ではなく起動元のターミナルアプリになる現象を実機で確認しています。誤って許可を押すとマイクアクセス権が別アプリに付与されてしまうため、詳しい手順は必ず [`desktop/README.md`](desktop/README.md) の該当節を読んでから行ってください
- 録音互換: WKWebView の `MediaRecorder` は `audio/webm` 系・`audio/mp4` 系の両方に対応していることを実機で確認済みで、既存の録音→文字起こしフローがこのシェル上でもそのまま動く見込みです
- 配布は未実施です。現状は未署名（ad-hoc署名のみ）のローカルビルドの `.app` のみで、GitHub Releases 等での配布は Phase 2 の予定です（コピーした先の Mac では Gatekeeper の警告が出る可能性があります）
- 開発者向け注意: サーバ側のコードを変更した直後にこのシェルで動作確認する場合は、必ず `launchctl kickstart -k gui/$(id -u)/com.local.solo-eikaiwa.server` でデーモンを再起動してから行ってください（再起動を忘れると、変更前の古いデーモンに対して検証してしまい正しく反映されているように見えない、という実害が確認されています）

## LLM プロバイダの切替

コーチ・会話・コンテンツ生成が使う LLM バックエンドは環境変数 `LLM_PROVIDER` で切り替えられる。既定（未設定 or `claude`）は Anthropic Claude Agent SDK で、現行と完全に同一の挙動。env 直接運用（ヘッドレス・CLI）の設定は `app/.env`（gitignore 済み）に置く。LaunchAgent の plist には秘密情報を書かない。ふだんの切替は「記録・測定」の **⚙️ 設定**（**モデル接続設定** / **用途ごとのモデル**タブ）から行い、保存すると実行中のアプリへ再起動なしで即時適用される（設定は SQLite の `llm_settings`〔接続〕・`llm_role_settings`〔ロール割当〕・`llm_role_tuning`〔ロール別チューニング〕・`llm_auth`〔認証モード〕に保存。**APIキーは UI・DB には一切保存されず `app/.env` の `OPENAI_COMPAT_API_KEY` / `ANTHROPIC_API_KEY` / `CODEX_API_KEY` のみ**）。

**設定画面の構成（モデル接続設定 / 用途ごとのモデル）**: **⚙️ 設定**の**モデル接続設定**タブでローカル LLM（OpenAI 互換）の Base URL・モデル名、Codex の任意モデル名、Claude/Codex それぞれの**認証モード**（サブスク/APIキー・後述）を定義する（Claude はサブスクリプションが既定のため接続設定は不要）。**用途ごとのモデル**タブで、LLM 呼び出しを5つの用途に分け、それぞれ **Claude / ローカル / Codex** を直接割り当てる（タブ先頭の**優先クラウド**（Claude / Codex・既定 Claude）でプリセット適用時のクラウド枠の課金先を選び、その下の**プリセット**は割当をワンタップで書き換えるボタン）。

| ロール | 使われる場面 | 推奨 |
| --- | --- | --- |
| 会話 | 自由会話・ロールプレイの相手応答 | ローカル — 応答が最も速いため（品質が物足りなければ Claude・Codex へ） |
| クイック支援 | 発話1文の訳・言い方ヒント・訂正のちょっとした解説 | ローカル — 単純で即答が欲しいタスクのため（クラウドなら haiku で十分） |
| コーチング | AE添削・振り返り・シャドーイングの訳解説・トーク解説 | Claude・Codex — SRSに残る添削や恒久キャッシュされる解説は初回の品質が勝負のため |
| 教材生成 | モデルトーク・4/3/2 準備・生成コンテンツ（CLI 含む） | ローカル — 出力が定型的で要求性能は低め（品質重視なら Claude・Codex へ） |
| 測定 | レベル測定・月次レビュー | Claude・Codex — 実行頻度が低く、質の高さが最優先のため |

クイック支援に個別設定が無ければコーチングの設定を継承し、コーチングも未設定なら全体設定（グローバル）を継承する（既存ユーザーは何も変えなければ挙動は完全に不変）。
※ 生成 CLI（`scripts/generate-content.ts`）は設定画面のロール割当ではなく環境変数に従う（CLI プロセスには DB のロール設定が効かない・詳細は後述）。

プリセットは3種で、直上で選ぶ**優先クラウド**（**Claude**〔既定〕/ **Codex**）がプリセットの「クラウド枠」に入る先を決める。**オールローカル**（全用途=ローカル・優先クラウドは無関係）、**バランス〔推奨〕**（会話・クイック支援・教材生成=ローカル / コーチング・測定=優先クラウド）、**最高品質**（全用途=優先クラウド）。優先クラウドを Codex にすると、バランス・最高品質のクラウド枠はすべて Codex に置き換わる（プリセットの説明文は実際に一致したクラウド名を表示する）。バランスが測定を優先クラウドにするのは、測定〔レベル測定・月次レビュー〕が品質差が最も大きく実行頻度も低いため（高頻度・低リスクの会話やクイック支援・教材生成はローカルで速く安く、品質が要る用途は課金先のクラウドに寄せる配分）。ローカルの接続先が未設定のときはローカルを使うプリセット・選択肢が中立に非活性化され、ロール割当保存時の「ローカル」枠も優先クラウドへフォールバックする。**最高品質を選んでもローカル接続の定義は保持**され、いつでもローカルに戻せる。優先クラウドはブラウザの localStorage に保存（既定 Claude・サーバ/DB には保存しない）。接続は `llm_settings`、ロール割当は `llm_role_settings` に保存し、APIキーは持たせない（`app/.env` のみ）。**設定を何も変えなければ挙動は現行と完全に同一**（既存のローカル接続・全用途ローカルの状態はそのまま表示・動作する）。env のみで運用する場合は下表の `LLM_PROVIDER` を `app/.env` に直接置けば従来どおり動く。

**ロール別チューニング（モデル/effort/配信）と推奨マトリクス**: 各ロール行の「詳細設定」を開くと、Claude 割当のロールは**モデル**（既定/haiku/sonnet/opus）、Codex 割当のロールは**配信**（既定/fast/standard）、Claude・Codex どちらの割当でも**effort（思考の深さ）**（既定/low/medium/high/xhigh/max）を個別に指定できる（ローカル割当には対応項目なし）。未指定（既定）はコード側の固定値に従う — Claude は SDK 標準（thinking 予算 adaptive）、Codex は effort=medium・配信=fast。「推奨チューニングを適用」ボタンは、今の割当でクラウド（Claude/Codex）側になっているロールだけを次の推奨値に一括で書き換える（ローカル割当のロールは変更しない。押しただけでは保存されず「割当を保存」で確定する）:

| ロール | Claude 推奨（モデル/effort） | Codex 推奨（effort/配信） |
| --- | --- | --- |
| 会話 | sonnet / low | low / fast |
| クイック支援 | haiku / 既定（effort 指定なし） | low / fast |
| コーチング | sonnet / high | medium / fast |
| 教材生成 | sonnet / medium | medium / fast |
| 測定 | opus / xhigh | xhigh / standard |

haiku は effort を指定しても実行時に黙って無視される（実測確認済み）ため、クイック支援の Claude 推奨は effort 未指定のままにしてあります（無視される値を表示するのは実際の挙動と食い違うため）。Codex のモデル自体はロール別ではなく「モデル接続設定」タブの Codex 任意モデル名で全ロール共通に固定します — **未指定なら Codex CLI の最新既定に自動追従**します（Claude のエイリアスが常に最新版へ解決されるのと同じ考え方）。

**実効モデルの可視化・選択**: 「用途ごとのモデル」タブの「モデル一覧を更新」ボタンで、Claude（Agent SDK の対応モデル一覧）・Codex（`codex app-server` のモデル一覧）・ローカル（接続先の `/models`）から実際のモデル一覧を取得し、各ロールのモデル/effort/配信の選択肢に反映します（取得は最大1時間キャッシュ）。取得できないソース（CLI 不在・接続不可など）は推測せず「実体未確認」と表示し、選択肢は現行の静的リストへ自動的に劣化します（嘘の表示をしません）。各ロール行には常時「実効: 〇〇 / effort ×× / 配信 △△」の1行サマリが出て、いま実際に使われている具体モデルID（例: sonnet エイリアスの実体である `claude-sonnet-5` のようなバージョン、Codex の配信モデル）・effort・配信が一目で分かります。クイック支援がコーチングを継承しているときは継承後の解決値がそのまま表示されます。Codex のモデル選択肢には CLI 既定のモデルに「CLI既定」バッジが付きます。

**認証モード（サブスクリプション / APIキー）**: 「モデル接続設定」タブで Claude・Codex それぞれの認証方式を選べます。既定は**サブスクリプション**（現行どおり、あなたの CLI ログイン — Claude Pro/Max または Codex の ChatGPT ログイン — に相乗りし、追加課金は発生しません）。**APIキー**に切り替えると、api.openai.com / Anthropic API の**従量課金**（サブスクの利用枠とは別）でリクエストします。キーは従来どおり `app/.env`（`ANTHROPIC_API_KEY` / `CODEX_API_KEY`）にのみ置き、UI・DB・API応答・ログには一切保存・出力されません（UI はキーの有無だけを表示し、対応する env キーが未設定の間は APIキーモードを選べません）。Claude の APIキーモードは SDK 経路・`claude -p` フォールバック経路の両方に `ANTHROPIC_API_KEY` を渡し、`claude -p` はさらに `--bare`（OAuth/キーチェーンを一切読まない厳格モード）を付けて起動します。Codex の APIキーモードは、隔離した専用ホームディレクトリ（`data/codex-home`・gitignore 済み）に一度だけ `codex login --with-api-key` を実行して認証情報を作り、以後の codex 呼び出し（app-server / exec 両経路）はこの隔離ホームだけを参照します — **あなた自身の `~/.codex`（ChatGPT ログイン）には一切触れません**。既に有効な `data/codex-home/auth.json` があるとこのログインはスキップされるため、`app/.env` の `CODEX_API_KEY` を差し替えた場合は `data/codex-home/auth.json` を削除してから APIキーモードを再適用すると新しいキーで再ログインされます。認証モードを切り替えると常駐中の `codex app-server` は再起動され、新しい認証情報が次回呼び出しから反映されます。なお APIキー経路ではモデル一覧配信に対応しないアカウント/エンドポイントがあり、その場合もカタログは「実体未確認」に自動で劣化します。

会話ロールがローカル LLM（OpenAI 互換）に解決されるときは、アプリを操作している間、API リクエスト受信を契機にバックグラウンドで極小リクエスト（`max_tokens=1`）を送ってモデルを常駐させる（240秒に1回まで・fire-and-forget でリクエスト処理には無影響・失敗は無視）。Ollama 等の既定アンロード（5分）に対して「利用中は常駐・離脱後は自然に解放」になり、初回会話のコールドスタートを抑える。Claude/Codex のときは何もしない。

### env の役割（UIで設定するもの / env だけで設定するもの）

**UI 真実性の原則**: 画面に表示される設定は必ず実際の挙動と一致します — 「既定」欄はコード側の固定値であり、env や画面に出ない裏設定では変化しません。

| 区分 | 項目 | 備考 |
| --- | --- | --- |
| **UI で設定**（サーバの唯一の真実 = DB） | LLM プロバイダ・接続（Base URL/モデル名/Codex モデル名）・ロール割当・ロール別チューニング（モデル/effort/配信）・認証モード（サブスク/APIキー） | ⚙️ 設定画面から変更。保存すると再起動なしで即時反映。優先順位は「ロール別チューニング > コード既定」のみで env による中間層はない |
| **env のみ**（secrets・CLI 専用） | secrets: `OPENAI_COMPAT_API_KEY` / `ANTHROPIC_API_KEY` / `CODEX_API_KEY` / `TTS_API_KEY`。ヘッドレス起動: `LLM_PROVIDER` 等（下表）。CLI専用チューニング: `CLAUDE_MODEL` / `CLAUDE_EFFORT` / `CODEX_REASONING_EFFORT` / `CODEX_SERVICE_TIER` | `app/.env` に置く。secrets は UI・DB・ログに一切出さない |

**破壊的変更（v0.24.0）**: これまでサーバが読んでいた `CLAUDE_MODEL` / `CLAUDE_EFFORT` / `CODEX_REASONING_EFFORT` / `CODEX_SERVICE_TIER` は、v0.24.0 以降サーバ本体では一切読まれません（UI に見えない裏設定を無くすため）。同名の env を `app/.env` に置いてもアプリ本体の挙動には影響しません（エラーにもならず、単に無視されます）。これらのチューニングは **⚙️ 設定 → 用途ごとのモデル** の詳細設定、または `scripts/generate-content.ts` 実行時の env（CLI 専用・下記「自分用にカスタマイズする」参照）でのみ有効です。

| プロバイダ | `LLM_PROVIDER` | 必要な env |
|---|---|---|
| Claude Agent SDK（既定） | 未設定 or `claude` | なし |
| Ollama | `openai-compat` | `OPENAI_COMPAT_BASE_URL=http://localhost:11434/v1`, `OPENAI_COMPAT_MODEL` |
| LM Studio | `openai-compat` | `OPENAI_COMPAT_BASE_URL=http://localhost:1234/v1`, `OPENAI_COMPAT_MODEL` |
| OpenAI API | `openai-compat` | `OPENAI_COMPAT_BASE_URL=https://api.openai.com/v1`, `OPENAI_COMPAT_API_KEY`, `OPENAI_COMPAT_MODEL` |
| GitHub Models | `openai-compat` | `OPENAI_COMPAT_BASE_URL=https://models.github.ai/inference`, `OPENAI_COMPAT_API_KEY`(PAT), `OPENAI_COMPAT_MODEL`（レート制限に注意） |
| OpenAI Codex CLI | `codex` | 任意 `CODEX_MODEL`（未指定は codex config 既定） |

- **GitHub Copilot は非対応**: 公式の汎用チャット API が無く、非公式プロキシは規約リスクがあるため。GitHub の LLM を使う場合は上記「GitHub Models」を利用する。
- **品質の前提**: 各ドメインのプロンプトは Claude 向けに調整されており、多くが「STRICT JSON のみ」を要求する。弱いモデルでは JSON 逸脱や品質低下が起きうるが、全ドメインがパース失敗フォールバックを持つためアプリはクラッシュせず degrade する。ローカル小モデルでは出力品質が落ちる前提で使う。
- **セッション継続**: プロバイダごとに継続の仕組みが異なる。**Claude**（既定）は Claude Agent SDK がセッションをディスクに永続化するため、サーバ再起動をまたいでも会話が復元される。SDK 経路が使えない・応答しない場合は、その呼び出しだけ `claude -p`（ワンショット実行）へ自動フォールバックする。`claude -p` もネイティブの `--resume` でディスクに永続化されるため、フォールバック中もサーバ再起動をまたいで同じ会話の続きから復元できる（Codex の exec フォールバックのような「履歴なしの新セッション」への劣化は起きない）。**Codex** は `codex app-server`（常駐プロセス・実験的プロトコル）のネイティブ thread として保存され、`thread/resume` によりサーバ再起動後も同じ会話の続きとして復元される（Claude と同等のパリティ）。ただし app-server が使えない・応答しない場合は、その呼び出しだけ従来の `codex exec`（ワンショット）へ自動フォールバックする。フォールバックに切り替わった最初のターンは**履歴なしの新セッション**として始まり、障害が続く間は exec 側のインメモリ・トランスクリプトで継続する（サーバ再起動で消える）。app-server が復帰してもフォールバック期間の文脈は引き継がれない（劣化動作）。**OpenAI 互換**はステートレスなため常にインメモリ・トランスクリプトで継続を再現し、サーバ再起動で会話履歴は失われる。
- **ハング検知タイムアウトの統一**: Claude Agent SDK 経路・`codex app-server`・ローカル LLM（openai-compat）はいずれも180秒応答が無ければタイムアウトする（フォールバックがある経路〔Claude・Codex〕はそのままフォールバックへ委譲し、無い経路〔openai-compat〕はエラーになる）。従来は `codex app-server` にしかなかった180秒タイムアウトを他経路にも揃えた
- **Codex の安全設定**: 既定経路の `codex app-server` は、スレッド作成・復元（`thread/start` / `thread/resume`）のたびにプロトコルレベルで `sandbox: "read-only"` + `approvalPolicy: "never"` を指定する（ユーザーの `~/.codex/config.toml` に依存しない）。承認・確認（elicitation）要求は自動で decline し、ファイル書き込みは機構的に禁止される。app-server が使えず `codex exec` へフォールバックしたときは、従来どおり CLI フラグ（`-s read-only` / `-c approval_policy="never"`）でユーザー config（`danger-full-access` 等）を上書きする。reasoning effort は既定で `medium`、service tier は既定で `fast`（priority 配信）をどちらの経路にも適用する（config が `xhigh` 等でも会話の応答待ちが伸びないように。**⚙️ 設定 → 用途ごとのモデル**の詳細設定で用途ごとに変更可 — アプリ本体は env のチューニング変数を読まない。tier はアカウント/モデルが非対応なら黙って標準配信になる）。動作確認済みの codex バージョンは `0.142.5`（`codex app-server` の初回起動時に1回だけ `codex --version` を確認し、それ以外は warn ログを出すのみで動作は継続する。プロトコル互換の検証方法は後述「自分用にカスタマイズする」参照）。
- **crash-loop のリスクは env 直接設定のときのみ**: `app/.env` の `LLM_PROVIDER` に不正な値を設定、または `openai-compat` で `OPENAI_COMPAT_BASE_URL` / `OPENAI_COMPAT_MODEL` を未設定のまま起動すると、サーバは起動時に throw して落ちる（fail-fast）。常駐運用では LaunchAgent（KeepAlive）が再起動を繰り返す crash-loop になるため、`data/logs/server.stderr.log` のエラーを確認して `app/.env` を修正するか、`LLM_PROVIDER` を空に戻す。一方、UI（**⚙️ 設定 → モデル接続設定 / 用途ごとのモデル**）からの変更は保存前に検証され不正な入力はエラー表示で弾かれ、起動時の DB 設定適用も fail-open（不正値は warn してフォールバックし常駐プロセスは落ちない）なので crash-loop にはならない。
- **CLI（generate-content 等）から使う場合**: Bun は cwd の `.env` しか自動ロードしないため、リポジトリルートからの `bun scripts/generate-content.ts …` では `app/.env` の設定は効かない。`LLM_PROVIDER=… bun scripts/generate-content.ts …` のように環境変数を直接付けるか、`cd app && bun ../scripts/generate-content.ts …` で実行する。

### ローカル LLM のおすすめ構成（Apple Silicon Mac の例）

```bash
brew install ollama && brew services start ollama
ollama pull qwen3:30b-instruct   # Qwen3-30B-A3B-Instruct（MoE・約18GB・RAM 32GB 以上推奨）
```

**⚙️ 設定 → モデル接続設定**の「ローカル LLM（OpenAI 互換）」に Base URL `http://localhost:11434/v1`・モデル名 `qwen3:30b-instruct` を入力して保存すれば完了（Ollama は API キー不要なので「キー未設定」表示のままで正常）。あとはプリセット **オールローカル**（全部ローカル）や **バランス**（会話・クイック支援・教材生成だけローカル）で用途割当を一括設定できる。

- **モデル選定の目安**: 訳・添削解説など日本語出力があるため、日英両対応のモデルを選ぶ（Qwen3 / Gemma 3 が有力）。**thinking 系の変種は避ける** — `<think>` タグが会話にそのまま表示・読み上げされてしまう。RAM 16GB の Mac なら `qwen3:8b` などの小型を。
- **使い分けの目安**: 会話相手・ロールプレイやクイック支援（訳・言い方ヒント）はローカル 30B 級で実用的（応答速度・即答性が最優先のため）。教材生成（モデルトーク・4/3/2 準備）も出力が定型的でローカルで十分だが、品質を上げたいときは Claude・Codex へ。添削の日本語解説（コーチング）・月次レビューやレベル測定（測定）は Claude・Codex の品質が明確に上なので、**⚙️ 設定 → 用途ごとのモデル**で品質が要る用途だけ Claude・Codex に寄せる運用がおすすめ（プリセット **バランス** で一括設定できる）。モデル性能が効く順は **測定 > コーチング > 教材生成**（会話は性能より応答の速さが効く）。Codex は応答待ち短縮のため reasoning effort が既定で `medium` に上書きされる（**⚙️ 設定 → 用途ごとのモデル**の詳細設定で用途ごとに変更可）。測定のような低頻度・品質重視の用途では引き上げても良い。
- 長い自由会話で文脈が切れる場合は Ollama のコンテキスト長を広げる: `OLLAMA_CONTEXT_LENGTH=16384 brew services restart ollama`

## 音声（TTS）プロバイダの切替

読み上げ音声（AI 応答・例文・モデルトーク）の合成先は OpenAI 互換の `/v1/audio/speech` を叩く。既定は OpenAI（`https://api.openai.com/v1`・`gpt-4o-mini-tts`・`alloy`）で、`OPENAI_API_KEY` があれば OpenAI、無ければ macOS `say` にフォールバックする（現行どおり）。ここを **Base URL・モデル・voice** の3点で差し替えられる。

- 設定場所: サイドバー「記録・測定」の **⚙️ 設定 → モデル接続設定**（音声/TTS の設定はモデル接続設定タブ内に統合済み）、または `app/.env` の `TTS_BASE_URL` / `TTS_MODEL` / `TTS_VOICE` / `TTS_API_KEY`（DB 設定が env を上書き）。
- **APIキーは UI・DB に保存されない**（`app/.env` の `TTS_API_KEY`・無指定なら `OPENAI_API_KEY` のみ）。Base URL が既定以外を指すときは**鍵なしでも**エンドポイントを試す（ローカルサーバ向け）。合成に失敗したら `say` にフォールバックする。
- 暗記例文390・多聴42本・モデルトーク72通りの**同梱音声**は既定（OpenAI）のキーで事前生成され、共通のディレクトリ（`content/sentences/audio/`）にまとめて格納されているため、TTS を差し替えると同梱にヒットせずローカル TTS の声で都度合成される（アプリ全体で声が揃う）。既定に戻せば同梱音声に戻る。
- キャッシュ（`data/tts-cache`）はモデル名と voice でキー分けされる。**同じモデル名かつ同じ voice のまま Base URL だけ別プロバイダに変える**と旧キャッシュと混ざりうるので、その場合は `data/tts-cache` を消すか voice/モデル名を変える。

### ローカル TTS の例: kokoro-fastapi（Apple Silicon Mac）

[kokoro-fastapi](https://github.com/remsky/Kokoro-FastAPI) は Kokoro-82M を OpenAI 互換 API で提供する軽量サーバ。Docker が最も手軽（**導入時に最新の起動方法を公式 README で確認すること**）:

```bash
# CPU（Docker Desktop for Mac は Linux コンテナに Apple GPU を渡せないため CPU 実行になる）
docker run -p 8880:8880 ghcr.io/remsky/kokoro-fastapi-cpu:latest
# 起動確認: ブラウザで http://localhost:8880/web を開く
```

Apple Silicon の MPS 加速で速くしたい場合は、Docker ではなくリポジトリの手順に沿って `uv` でネイティブ実行する（詳細は公式 README・**導入時に確認**）。Kokoro-82M は小型モデルで、Apple Silicon の CPU でも短文なら概ねリアルタイム（RTF < 1・1文あたり数百 ms〜1〜2 秒程度）。

設定は「⚙️ 設定 → モデル接続設定」で **Base URL `http://localhost:8880/v1`・モデル `kokoro`・voice `af_sky`**（54種の voice から選択・日英中対応）を保存すれば完了。kokoro-fastapi は鍵不要なので「TTS API キーなし」表示のままで正常。

## 自分用にカスタマイズする

お題・シナリオ（`content/topics/` / `content/scenarios/`）は frontmatter 付き Markdown ファイル1枚です。既存ファイルを真似て追加すれば、自動で least-recently-used ローテーションに入ります。同梱のお題はサンプルなので、自分の仕事・関心に合わせて差し替えてください。

```markdown
---
id: my-topic
kind: topic
title: "My topic"
title_ja: "私のお題"
---
Talk about:
- English hint — 日本語の補足
```

暗記例文（`content/sentences/sentences300.json`）も同じ発想で差し替え・追記できます（`no` の一意性だけ保つこと）。

自分で書く代わりに、練習の実力データから教材を自動生成することもできます（要 Claude Code ログイン・完全オリジナル生成。書き込み前に検証され、不正な生成物はリポジトリに書き込まれません）:

```bash
bun scripts/generate-content.ts sentences --dry   # 何が追加されるかのプレビュー（書き込みなし）
bun scripts/generate-content.ts sentences         # 例文練習の自己評価から苦手カテゴリを選び、例文を4文ずつ追記
bun scripts/generate-content.ts topics            # 現在のレベルに合ったお題2本+ロールプレイシナリオ1本を追加
```

生成物はリポジトリに恒久的に残るため、既定より高品質な設定を推奨します:

```bash
LLM_PROVIDER=claude CLAUDE_MODEL=opus CLAUDE_EFFORT=high bun scripts/generate-content.ts sentences
```

`CLAUDE_MODEL`（haiku/sonnet/opus）・`CLAUDE_EFFORT`（low/medium/high/xhigh/max）、`LLM_PROVIDER=codex` のときは `CODEX_REASONING_EFFORT` / `CODEX_SERVICE_TIER` を、この CLI 自身がホワイトリスト検証つきで解釈します（サーバ本体はこれらの env を読みません — 前述「env の役割」参照）。

生成した話し言葉系の教材（多聴・モデルトークなど）は、口語として自然か（短縮形率・平均文長・書き言葉語彙）を機械検証できます。AI 生成教材は手で直さず、検証 NG なら再生成してください:

```bash
bun scripts/check-spoken-register.ts   # 多聴素材の全件検証（1件でも不合格なら非ゼロ終了）
```

お題・シナリオ・多聴を帯×ドメインで均等に保ちたいときはカバレッジ validator、4/3/2 準備チャンク・モデルトークをお題ごとに事前生成したいときは topic-assets 生成 CLI が使えます（どちらも同じ検証つき生成ループ・手修正禁止の運用）:

```bash
bun scripts/check-content-coverage.ts   # 3レベル帯×3ドメインの充足状況を表示（不足があれば非ゼロ終了・--jsonで機械可読出力）
bun scripts/generate-topic-assets.ts    # 全お題×帯内stageのprepPack/model talkを事前生成（差分のみ・--forceで強制再生成）
```

**編集・生成したあとの反映のさせ方**（ここだけ覚えれば大丈夫です）:

| 何を変えた | やること |
|---|---|
| お題・シナリオ（`content/topics/`・`content/scenarios/`） | 何もしなくてOK（次のメニューから自動で反映） |
| 暗記例文（手編集・`generate-content.ts sentences`） | ① 音声を差分生成: `cd app && bun ../scripts/generate-sentence-audio.ts`（要 OPENAI_API_KEY・生成済みはスキップ） ② サーバを再起動（例文は起動時に読み込むため。常駐なら `./scripts/status-daemon.sh` で確認して `launchctl kickstart`、開発なら `bun run dev` を再起動） |
| 多聴・topic-assets（モデルトーク）を追加/更新した | 音声を差分生成: `cd app && bun ../scripts/generate-content-audio.ts`（`listening` / `model-talk` / `all` を指定可・既定 all・要 OPENAI_API_KEY・生成済みはスキップ） |

音声を生成しない場合も動きます（その文だけ macOS `say` の声になります）。新しい例文の「もっと詳しく」解説は、初回に押したときに生成されて以降はキャッシュされます。

Codex（`codex app-server`）は実験的プロトコルに依存するため、破壊的変更が無いかを手動で検出できます: `./scripts/check-codex-protocol.sh`（要 `jq`。`codex app-server generate-json-schema` の出力を `app/server/providers/codex-protocol.snapshot.json` と比較し、リリース前に実行）。

## テスト

```bash
cd app && bun test           # サーバユニット/契約テスト
cd app && bun run typecheck
cd app/client && bun run build
./scripts/smoke-stt.sh       # STT 実機スモーク
```

## ドキュメント

- [設計ドキュメント](docs/superpowers/specs/2026-07-05-learn-english-system-design.md) — システム構成と学習方法論（10原則）
- [リサーチレポート](docs/research/) — 流暢性・語彙・チャンク・シャドーイング・AI会話・継続/習慣化の検証済み知見
- [実装計画](docs/superpowers/plans/) — 各マイルストーンの実装計画
- [CHANGELOG](CHANGELOG.md)

## ロードマップ

当初計画（M1〜M5）と、その後の UX 一貫性（P1〜P5）・リファクタリング（R1〜R5）・インプット&語彙強化（P6）・出だしの難易度調整（P7）はすべて完了し、主要機能は一巡しています。現在は**実使用でフィードバックを溜めるフェーズ**です（練習後の1タップ評価がそのまま次の開発サイクルの入力になります）。

次期候補として、実行可能な実装計画を書き溜めてあります（[docs/superpowers/plans/](docs/superpowers/plans/)）:

- **進歩の見える化**: 月次レビューの先月比較・レベル測定の前回比較
- **セッション再開**: 強化セッションを途中で閉じても当日中は続きから再開
- **stage 別カリキュラム**: 日替わりメニューの構成・配分をレベル帯（入門/中級/上級）で変える

## ライセンス

[MIT](LICENSE)
