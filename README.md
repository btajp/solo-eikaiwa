# learn-english

毎日5分から回せる、自分専用の英会話ジム。録音した声をローカルで文字起こしし、AIが会話相手とコーチを務め、練習履歴が貯まっていく — すべて自分の Mac の上で。
A local-first, research-grounded English speaking practice app for daily self-study on macOS.

個人開発のツールを公開しているものです。Issue / PR は歓迎しますが、対応は保証しません。

## できること

### 🔊 クイックドリル（5〜10分）— 毎日のメイン

1日1本、5〜10分で終わる単品ドリル。研究上、総学習時間より「頻度と完了」が上達に効くため、これが日々のデフォルト導線です。

- **音読ウォームアップ（6分）** — 今日のお題の表現チャンクを声に出して準備。各表現は🔊ボタンでネイティブ音声を聞ける
- **4/3/2ミニ（8分）** — 同じ話を制限時間を縮めながら2回話す流暢性トレーニング。話す前に「表現・話の骨組み・モデルトーク」の準備フェーズがあり、ラウンド間には AI が言い間違いを日本語で解説
- **ロールプレイ（10分・日常/ビジネス/IT の3種）** — レストランや旅行、会議や日程調整、障害対応やベンダー対応など、選んだ場面のシナリオで AI と役割練習
- **シャドーイング（5分）** — AI が生成した短いモデルトークに重ねて発話。「日本語訳と解説」ボタンで全文訳と表現ポイントも確認できる

### 📋 強化セッション（60分 / 30分・週1〜2回）

音読ウォームアップ → 4/3/2 → ロールプレイ → シャドーイング → 振り返り、の5ブロック通し練習。振り返りでは今日の発話から AI が改善ポイントをまとめます。

### 💬 自由会話

英語でただ話す。録音ボタンを押して話すと、ローカルで文字起こしされ、AI が音声で返してきます。

### 📖 暗記例文300

会話でそのまま使える文法・言い回しを網羅したオリジナル300文（文法・機能25分類 × 日常/ビジネス/IT）。**日本語を見て声に出す → 答え合わせ（音声つき）→ 3段階の自己評価**という産出リトリーバル型で、評価に応じて 1→3→7→14→30→60日 の間隔反復（SRS）が次の出題日を決めます。一覧モードでは全文をフィルタ・音声つきで眺められます。

300文の音声はリポジトリに同梱済み（`content/sentences/audio/`、OpenAI TTS で事前生成したAI音声）なので、**OpenAI キーなしでもネイティブ品質の音声で練習できます**。

### 🎧 多聴

レベルに合った短い英語（日常/ビジネス/IT × 難易度帯・各2〜4分）を、スクリプトを隠したまま通しで聴くリスニング練習。聴き終えたらボタンでスクリプト表示・日本語訳と表現解説も確認できます。聴いた本数は「今週◯本」の情報表示のみでノルマはありません。素材は生成CLIで自分のレベルに合わせて増やせます。

### 📐 レベルとプレースメント

練習の難易度はレベル（Lv1〜、上限なし）が駆動します。4/3/2 の持ち時間、モデルトーク・準備チャンク・言い直し例の語彙と構文（入門帯は A2・短文中心）、お題の帯域がレベルに応じてなだらかに変化し、ブロック完了や例文の自己評価で貯まる XP がレベルを押し上げます。ステージ境界（Lv10/20/…）だけは自動で跨がず、実績（練習日数・完了率）を根拠つきで提示して承認制で昇格します。降格も「調整の提案」としてのみ出ます — 完了率や中断だけでなく「時間はかけたのに発話が伸びない」実測シグナルも材料にしつつ、XP は減らず、自動降格もありません（動機づけ研究の知見に沿った情報的フィードバック設計です）。各練習画面には難易度の実態チップ（「Lvに自動調整」「Lv帯で選ぶ」「全レベル共通」）が表示されます。

初回は**レベル測定（約10分）**がおすすめ: 自己紹介 → 状況説明 → 意見の3タスクを録音すると、CEFR 記述子ベースのルーブリックで開始レベルが提示されます（反映するかはあなたが決めます）。以後は30日ごとに月次測定の導線が出て、話す力の変化を定点観測できます。

30日ごとに Progress 画面で**月次レビュー**も書いてもらえます。直近30日の練習時間・調音速度・例文の定着・収集チャンクなどをまとめた日本語の振り返りレポートです（情報表示のみ・ノルマや判定はありません）。

### 📚 ライブラリと練習記録

- 生成されたモデルトークは自動でライブラリに保存され、あとから本文確認・再再生できる
- ホームの GitHub 風カレンダーと練習記録（今週◯日・累計◯日）で継続が見える。連続日数を煽る演出は意図的に置いていません（切れたときのモチベーション低下が研究で示されているため）
- **練習フィードバック**: セッション完了・自由会話・多聴の後に「今のはどうでしたか？（キツい/ちょうどいい/簡単 + 任意メモ）」の1タップ評価。溜まった記録は「フィードバック」画面で一覧・Markdown コピーでき、アプリ改善の入力に使えます（タップしなければ何も起きません）
- サイドバーは**今日の練習 / 自主練 / 記録・測定**の3セクション構成。自主練の取り組み順ヒント（聞く→覚える→話す）を ⓘ で確認できます。「記録・測定」の **⚙️ 設定**で LLM プロバイダ（用途別ルーティング含む・後述）と文字サイズ・言語を変更できます。
- UI はデフォルト英語。**⚙️ 設定 → 表示**の **EN / 日本語** でいつでも切り替え可能

## 学習設計の根拠

セッション構成は思いつきではなく、第二言語習得（SLA）研究のメタ分析・原典を3票の敵対的検証にかけた[リサーチレポート3本](docs/research/)に基づいています。核になっている知見:

- **4/3/2 時間圧反復**が発話速度・流暢性を向上させる（準備フェーズと明示的フィードバックの併用でさらに効果）
- **産出リトリーバル**（思い出して口に出す）は受容型学習より記憶定着に有効
- **間隔反復**は複雑なアルゴリズム不要。長めの固定間隔で十分
- **頻度 > 総時間**。1日サボっても無害、1週間空くと有害 — だから「短くても毎日」

詳細は[設計ドキュメント](docs/superpowers/specs/2026-07-05-learn-english-system-design.md) §5（方法論10原則）へ。

## 仕組みとプライバシー

```
ブラウザ録音 → whisper.cpp（ローカルSTT） → Claude（会話相手・コーチ） → OpenAI TTS（なければ macOS say）
```

- **音声はマシンから出ません**。外部に送られるのは発話のテキスト（Claude へ）と AI 応答のテキスト（TTS 用、キー設定時のみ）だけ
- 学習データ（録音・トランスクリプト・進捗・SRS状態・キャッシュ）はすべて `data/` のローカルファイルで、**リポジトリには一切コミットされない**
- API サーバは 127.0.0.1 バインドのみ（外部非公開）
- 対話 AI は Claude Agent SDK 経由であなたの Claude Pro/Max サブスクリプションを使うため、**Anthropic API キーは不要**

## はじめる

### 前提条件

- macOS（Apple Silicon 推奨）
- [Bun](https://bun.sh) ≥ 1.3
- Homebrew（whisper-cpp / ffmpeg の導入に使用）
- [Claude Code](https://claude.com/claude-code) CLI にログイン済みであること（既定の LLM。Ollama 等のローカル LLM や Codex への切替は「LLM プロバイダの切替」参照）
- 任意: OpenAI API キー（高品質TTS用。なければ macOS `say` で動作）
- Chrome 系ブラウザ推奨（録音が audio/webm 固定のため。Safari 非対応）

### セットアップ（初回のみ）

```bash
./scripts/setup.sh   # brew 依存・whisperモデル(約1.6GB)DL・bun install
```

任意で `app/.env` に OpenAI キーを設定（環境変数参照も可）:

```
OPENAI_API_KEY=$YOUR_OPENAI_KEY_ENV_VAR
```

### 起動: 常駐（推奨）

2つの常駐プロセスで動きます。**API サーバ**（launchd の LaunchAgent・ポート3111）と、ビルド済みクライアントの静的配信＋ `/api` プロキシを担う **Caddy** です。どちらもログイン時に自動起動し、クラッシュ時は自動再起動します。

**① API サーバの常駐**（このリポジトリのスクリプトで完結）:

```bash
./scripts/install-daemon.sh   # クライアントビルド → LaunchAgent 登録 → ヘルスチェック
```

**② Caddy の用意**（マシンごとに初回のみ）。API サーバはクライアントを配信しないため、ブラウザの入口には Caddy が必要です。Homebrew の Caddy を常駐サービスにする例:

```bash
brew install caddy
# 1. このリポジトリの Caddyfile 内 root のパスを自分のチェックアウト先に合わせて編集
# 2. Homebrew の Caddyfile（/opt/homebrew/etc/Caddyfile）に import 行を追加:
#      import /path/to/learn-english/Caddyfile
brew services start caddy    # ログイン時自動起動の常駐サービスとして登録
caddy trust                  # ローカルCA証明書をキーチェーンへ登録（初回のみ・要パスワード）
echo "127.0.0.1 learn-english" | sudo tee -a /etc/hosts   # https://learn-english 用
```

ブラウザで https://learn-english を開く（hosts を編集しない場合は https://learn-english.localhost — Chrome 系なら hosts 不要）。

- 状態確認: `./scripts/status-daemon.sh` / 停止・解除: `./scripts/uninstall-daemon.sh`
- コードを更新したら `./scripts/install-daemon.sh` を再実行（再ビルド＋デーモン再起動が一括で済む）
- Caddyfile を変更したら Caddy に再読み込みさせる: brew services 構成なら `brew services restart caddy`、共有 Caddy デーモン構成なら `sudo launchctl kickstart -k system/com.local.https.caddy`
- Firefox で証明書警告が出る場合: `about:config` で `security.enterprise_roots.enabled` を `true` に（Firefox は macOS キーチェーンを標準では参照しないため）

### 起動: 開発

```bash
cd app && bun run dev        # APIサーバ :3111（127.0.0.1 のみ）
cd app/client && bun run dev # UI :5173（/api をプロキシ）
```

ブラウザで http://localhost:5173 を開く。常駐運用（https://learn-english）とは独立して動きます。ポート3111は共用なので、常駐と開発サーバは同時に起動できません。

## LLM プロバイダの切替

コーチ・会話・コンテンツ生成が使う LLM バックエンドは環境変数 `LLM_PROVIDER` で切り替えられる。既定（未設定 or `claude`）は Anthropic Claude Agent SDK で、現行と完全に同一の挙動。設定は `app/.env`（gitignore 済み）に置く。LaunchAgent の plist には秘密情報を書かない。「記録・測定」の **⚙️ 設定 → 言語モデル**からも切替でき、保存すると実行中のアプリへ再起動なしで即時適用される（設定は SQLite の `llm_settings` 単一行に保存。**APIキーは UI・DB には保存されず `app/.env` の `OPENAI_COMPAT_API_KEY` のみ**）。「既定（環境変数）」を選ぶと `app/.env` の `LLM_PROVIDER` に従う状態へ戻る。

**用途別ルーティング（設定画面）**: サイドバー「記録・測定」の **⚙️ 設定 → 言語モデル**で、LLM 呼び出しを4つの用途ロールに分けて別々のプロバイダに割り当てられる。

| ロール | 使われる場面 |
| --- | --- |
| 会話 | 自由会話・ロールプレイの相手応答 |
| コーチング | 添削・振り返り・訳・言い方ヒント・各種解説 |
| 教材生成 | モデルトーク・4/3/2 準備・生成コンテンツ（CLI 含む） |
| 測定 | レベル測定・月次レビュー |

※ 生成 CLI（`scripts/generate-content.ts`）は設定画面のロール割当ではなく環境変数に従う（CLI プロセスには DB のロール設定が効かない）。

各ロールの既定は「全体に従う（inherit）」で、全体の接続先（上記表の `LLM_PROVIDER` 相当）をそのまま使う。**推奨構成を適用**は、全体をローカル LLM（OpenAI 互換）に接続済みのときだけ有効で、会話だけをそのローカルモデルに割り当て、コーチング・教材生成・測定は既定（Claude）に残す（高頻度・低リスクの会話はローカルで速く安く、品質が要る用途は動作確認済みの Claude に寄せる、という配分）。**すべて既定に戻す**で全体=環境変数の既定・全ロール inherit に戻せる。ロール別設定は `llm_role_settings` テーブルに保存し、APIキーは持たせない（`app/.env` のみ）。**設定を何も変えなければ全ロール inherit のままで、現行と完全に同一の挙動**。

会話ロールがローカル LLM（OpenAI 互換）に解決されるときは、アプリを操作している間、API リクエスト受信を契機にバックグラウンドで極小リクエスト（`max_tokens=1`）を送ってモデルを常駐させる（240秒に1回まで・fire-and-forget でリクエスト処理には無影響・失敗は無視）。Ollama 等の既定アンロード（5分）に対して「利用中は常駐・離脱後は自然に解放」になり、初回会話のコールドスタートを抑える。Claude/Codex のときは何もしない。

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
- **セッション継続**: OpenAI 互換・Codex はステートレスなため、会話の継続はサーバのインメモリ・トランスクリプトで再現する。サーバ再起動で会話履歴は失われ、進行中の会話は文脈を忘れて新セッションとして継続される（既定の Claude SDK はセッションをディスクに永続化するため再起動をまたいで復元される。この差は許容とする）。
- **Codex の安全設定**: Codex アダプタは常に read-only サンドボックス（`-s read-only`）・非対話（`approval_policy="never"`）・中立な作業ディレクトリで `codex exec` を起動し、ユーザーの `~/.codex/config.toml`（`danger-full-access` 等）を CLI フラグで上書きする。テキスト応答のみを取得し、ファイル書き込みは機構的に禁止される。reasoning effort は既定で `medium` に上書きし、service tier は既定で `fast`（priority 配信）を要求する（config が `xhigh` 等でも会話の応答待ちが伸びないように。`CODEX_REASONING_EFFORT` / `CODEX_SERVICE_TIER` で変更可。tier はアカウント/モデルが非対応なら黙って標準配信になる）。
- **crash-loop のリスクは env 直接設定のときのみ**: `app/.env` の `LLM_PROVIDER` に不正な値を設定、または `openai-compat` で `OPENAI_COMPAT_BASE_URL` / `OPENAI_COMPAT_MODEL` を未設定のまま起動すると、サーバは起動時に throw して落ちる（fail-fast）。常駐運用では LaunchAgent（KeepAlive）が再起動を繰り返す crash-loop になるため、`data/logs/server.stderr.log` のエラーを確認して `app/.env` を修正するか、`LLM_PROVIDER` を空に戻す。一方、UI（**⚙️ 設定 → 言語モデル**）からの変更は保存前に検証され不正な入力はエラー表示で弾かれ、起動時の DB 設定適用も fail-open（不正値は warn してフォールバックし常駐プロセスは落ちない）なので crash-loop にはならない。
- **CLI（generate-content 等）から使う場合**: Bun は cwd の `.env` しか自動ロードしないため、リポジトリルートからの `bun scripts/generate-content.ts …` では `app/.env` の設定は効かない。`LLM_PROVIDER=… bun scripts/generate-content.ts …` のように環境変数を直接付けるか、`cd app && bun ../scripts/generate-content.ts …` で実行する。

### ローカル LLM のおすすめ構成（Apple Silicon Mac の例）

```bash
brew install ollama && brew services start ollama
ollama pull qwen3:30b-instruct   # Qwen3-30B-A3B-Instruct（MoE・約18GB・RAM 32GB 以上推奨）
```

**⚙️ 設定 → 言語モデル**で **OpenAI 互換** を選び、Base URL `http://localhost:11434/v1`・モデル名 `qwen3:30b-instruct` を保存すれば完了（Ollama は API キー不要なので「キー未設定」表示のままで正常）。

- **モデル選定の目安**: 訳・添削解説など日本語出力があるため、日英両対応のモデルを選ぶ（Qwen3 / Gemma 3 が有力）。**thinking 系の変種は避ける** — `<think>` タグが会話にそのまま表示・読み上げされてしまう。RAM 16GB の Mac なら `qwen3:8b` などの小型を。
- **使い分けの目安**: 会話相手・ロールプレイ・訳はローカル 30B 級で実用的。添削の日本語解説・月次レビュー・レベル測定は Claude の品質が明確に上なので、**⚙️ 設定 → 言語モデル**の用途別ルーティングで会話だけをローカルに割り当てる運用がおすすめ（前述「推奨構成を適用」で一括設定できる）。
- 長い自由会話で文脈が切れる場合は Ollama のコンテキスト長を広げる: `OLLAMA_CONTEXT_LENGTH=16384 brew services restart ollama`

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

**編集・生成したあとの反映のさせ方**（ここだけ覚えれば大丈夫です）:

| 何を変えた | やること |
|---|---|
| お題・シナリオ（`content/topics/`・`content/scenarios/`） | 何もしなくてOK（次のメニューから自動で反映） |
| 暗記例文（手編集・`generate-content.ts sentences`） | ① 音声を差分生成: `cd app && bun ../scripts/generate-sentence-audio.ts`（要 OPENAI_API_KEY・生成済みはスキップ） ② サーバを再起動（例文は起動時に読み込むため。常駐なら `./scripts/status-daemon.sh` で確認して `launchctl kickstart`、開発なら `bun run dev` を再起動） |

音声を生成しない場合も動きます（その文だけ macOS `say` の声になります）。新しい例文の「もっと詳しく」解説は、初回に押したときに生成されて以降はキャッシュされます。

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
