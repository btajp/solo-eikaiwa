# 教材ラダー拡充（v0.26）実装計画

> **歴史的計画文書**: 本文書は執筆時点のリポジトリ構成・ファイルパスのスナップショットであり、その後のリファクタ（ファイル分割・改名等）は反映していません。現在の構成は [README.md](../../../README.md) / [AGENTS.md](../../../AGENTS.md) を参照してください。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** 各メニューの教材を全レベル帯で事前生成・同梱し、進級しても教材が途切れないラダーを作る（spec: `docs/superpowers/specs/2026-07-09-content-ladder-design.md` が設計の正）

**Architecture:** wave0 で検証基盤を固め、wave1 で空白セル（daily/business s5-6）を即応、以降 listening 3帯化 → topic-assets 3層 → 例文 → 音声同梱の順で在庫を積む。生成は全て `LLM_PROVIDER=claude CLAUDE_MODEL=opus CLAUDE_EFFORT=high` + 機械検証 FAIL 再生成ループ（手修正禁止）。

**Tech Stack:** Bun + TypeScript（サーバ新ロジック TDD・生成 CLI は scripts/）

## Global Constraints

- AI 生成教材の手修正禁止（検証 NG なら再生成のみ）— AGENTS.md
- 検証ゲート3種を各タスクで通す
- 数量・帯・形式は spec §3-§7 の確定値に従う（3帯 [1,2]/[3,4]/[5,6]・quota は帯×domain 均等・bridge は quota 外）
- 研究制約: 情報的フィードバックのみ（rotation 注記は「近いレベルの教材を選びました」調・警告禁止）
- 生成コミットは content/ 配下のみを明示ステージ（コード変更と分離）

---

### Task 1 (wave0): カバレッジ validator + タイプ別検証拡張

**Files:**
- Create: `app/server/content-coverage.ts`（純ロジック: quota 表・stage 単位適合数・bridge[範囲>1帯]の quota 外扱い・不足セル列挙）/ Test: `content-coverage.test.ts`
- Create: `scripts/check-content-coverage.ts`（topics/scenarios/listening の現物を読み quota 充足レポート・不足あれば exit≠0。--json で機械可読出力）
- Modify: `app/server/spoken-register-check.ts`（タイプ別検証の追加: `checkModelTalk`=listening と同 hard fail / `checkPrepChunk`=1chunk 単位で完全文・語数範囲・placeholder なし / `checkScenarioStarter`=starters のみ口語検証）/ 既存 listening 検証は不変。Test 追加
- Create: `app/server/topic-anchor-check.ts`（新規 topic の `experienceAnchor`/`memoryCue`/`commonObjectsOrActions` frontmatter 検証 + 禁止カテゴリ[抽象論/専門知識/時事/希少趣味/個人情報前提]の語彙ヒューリスティック + 抽象タイトル検出）/ Test

- [ ] TDD → 3ゲート → 実行: `bun scripts/check-content-coverage.ts` が現状の不足セル（daily s5-6 ゼロ等）を正しく列挙することを実データで確認（この時点で exit≠0 が正常）
- [ ] Commit `feat: 教材カバレッジvalidatorとタイプ別口語検証（model talk/prep chunk/scenario starters/topic anchor）`

### Task 2 (wave1): 空白セル即応 — daily/business s5-6 の topics+scenarios

**Files:**
- Modify: `app/server/content-gen.ts`（genTopicsBand/genScenarios を「対象帯×domain×本数」指定で生成できるよう拡張。新規 topic は experienceAnchor 3点 frontmatter を必須出力・spoken-style 注入・Task 1 の検証を生成後に適用）
- Modify: `scripts/generate-content.ts`（band/domain/count 引数 or 不足セル自動検出モード `--fill-coverage`）
- Test: 生成関数のプロンプト/検証配線（フェイク runner）

- [ ] TDD（コード）→ 3ゲート → コードだけ先に Commit `feat: 帯×domain指定の教材生成とexperienceAnchor必須化（--fill-coverage）`
- [ ] 生成実行（**T1 の bridge 全数判明を受けて対象拡大**）: 既存教材は全件 bridge のため quota 適合在庫はゼロ。**topics 36本（帯×domain 各4・全セル）+ scenarios 27本（各3・全セル）を全数生成**する。生成順は「bridge 含めてもカバレッジゼロのセル」= daily [5,6] を先頭に（無警告振替の実害を最初に解消）。検証（anchor+starter 口語+coverage）PASS まで再生成（セルあたり3ラウンド規律・FAIL したらプロンプト差し戻し）
- [ ] 生成 Commit `feat: 全帯×全domainの帯適合topics/scenariosを生成（quota充足・daily fluency空白解消）`

### Task 3 (wave2): listening 3帯化 + 36本

**Files:**
- Modify: `app/server/content-gen.ts`（LISTENING_PLAN を 3帯 [1,2]/[3,4]/[5,6]×3domain×4本=36 スロットに改定・既存ファイルの id/スロットは温存して不足分のみ生成できるように）
- Modify: `app/server/spoken-register-check.ts`（intermediate 帯閾値の初期較正: 旧素材 FAIL + 例文300 PASS + v0.25 再生成6本 PASS を制約に、緩め設定から。較正テスト固定）

- [ ] TDD → 3ゲート → コード Commit `feat: 多聴を3帯36本プランへ拡張（既存温存・不足分生成・intermediate較正）`
- [ ] 生成実行（**bridge 判明を反映**）: 既存6本は [1,3]/[4,6] の bridge のため quota 外（削除せず余剰として温存）。**帯適合の新規36本**（[1,2]/[3,4]/[5,6] × 3domain × 4・level は帯範囲そのもの）を生成。checker 全件 PASS まで（セルあたり3ラウンド規律・it 帯はマージン薄の申し送りあり・要ラウンド注視）
- [ ] 生成 Commit `feat: 多聴教材を3帯36本に拡充（帯適合・機械検証全件PASS）`

### Task 4 (wave3): topic-assets（prepPack + model talk の3層化）

**Files:**
- Create: `app/server/topic-assets.ts`（`{ topicId, sourceHash, promptVersion, byStage: { [stage]: { prepPack, modelTalk } } }` の読み込み・sourceHash 検証つきルックアップ）/ Test
- Modify: `app/server/index.ts`（prepPack/modelTalk の解決を **同梱 JSON → DB キャッシュ → 実行時生成** の3層に。model_talks の既存テーブルは DB 層として read-before-generate を実装）
- Create: `scripts/generate-topic-assets.ts`（全 topic × frontmatter range 内 stage をバッチ生成・Task 1 の checkPrepChunk/checkModelTalk で検証・FAIL 再生成・content/topic-assets/*.json へ書き込み）
- Test: 3層フォールバック順・stale(sourceHash 不一致)時は同梱を無視して次層へ

- [ ] TDD → 3ゲート → コード Commit `feat: topic-assets 3層ルックアップ（同梱→DB→実行時生成・sourceHash stale検出）`
- [ ] 生成実行: 約72 スロット。生成 Commit `feat: 全topicのprepPack/model talkを事前生成して同梱`

### Task 5 (wave4): spoken function 例文 +90

**Files:**
- Modify: `app/server/content-gen.ts`（genSentences に spoken function カテゴリ群[依頼/断り/聞き返し/言い換え/相槌 等]と帯タグ付き生成モード。新規例文に optional `band` フィールド[additive・SRS/選定ロジックは不変]）
- Modify: `scripts/generate-content.ts`（サブコマンド or フラグ）。解説（explanations）も同時生成

- [ ] TDD → 3ゲート → コード Commit → 生成実行（帯別30×3・検証: 形式+口語コーパス基準維持）→ 生成 Commit `feat: spoken function例文90文（帯別30・解説つき）を追加`

### Task 6 (wave5): 音声同梱 + rotation 情報的注記 + リリース v0.26.0

**Files:**
- Modify: `scripts/generate-sentence-audio.ts` → 一般化（listening 本文・model talk・新例文の TTS 事前生成。**実行時の TTS 要求テキストと完全一致する単位**で生成し sha256 命名を踏襲 — 単位はコードを読んで確定・ズレると同梱層にヒットしない）
- Modify: `app/server/rotation.ts` + ルート（fallback 発生を metadata 化）+ クライアント（「近いレベルの教材を選びました」の情報的注記・i18n EN/JA）
- Modify: README（できること・教材ラダー・生成/検証 CLI）+ CHANGELOG v0.26.0

- [ ] TDD（rotation metadata・注記の純ロジック）→ 3ゲート → 音声生成実行（要 OPENAI_API_KEY・冪等）→ Commit 分割（コード/音声/docs）
- [ ] 最終 whole-branch レビュー → merge → tag v0.26.0 → push → build+kickstart → health/https 200 → 台帳・メモリ更新 → Tauri Phase 1 へ
