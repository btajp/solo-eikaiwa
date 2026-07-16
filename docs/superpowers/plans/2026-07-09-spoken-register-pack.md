# v0.25 口語最適化パック 実装計画

> **歴史的計画文書**: 本文書は執筆時点のリポジトリ構成・ファイルパスのスナップショットであり、その後のリファクタ（ファイル分割・改名等）は反映していません。現在の構成は [README.md](../../../README.md) / [AGENTS.md](../../../AGENTS.md) を参照してください。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** 生成プロンプトの口語レジスター統一と多聴6本の再生成（監査 spoken-register-audit の改善パック）

**Architecture:** 共通の口語スタイル指示ブロックを1モジュールに置き、話し言葉を出力する生成プロンプト（prep pack / 言い方ヒント / AE better例文 / listening）へ注入する。教材は手修正禁止のため多聴6本は再生成し、機械検証（短縮形率・文長・書き言葉語彙）で合否判定する。

**Tech Stack:** Bun + TypeScript（既存規約: プロンプトは各ドメインモジュール・サーバ新ロジックTDD）

## Global Constraints

- AI 生成コンテンツの手修正は禁止（検証 NG なら再生成）— AGENTS.md
- 検証ゲート3種（bun test / typecheck / client build）を各タスクで通す
- 会話・コーチング等の既存プロンプトの意味を変えない（口語スタイルブロックの追記のみ）

## 監査事実（2026-07-08・binding な出発点）

- 例文300: 平均9.58語/文・短縮形37%・書き言葉語彙ほぼ0 → **良好基準のコーパス**
- 多聴6本: 初級2本=短縮形0%の教科書調 / 上級3本=平均17.8〜19.4語/文のエッセイ調 → **不合格の現物**
- prep pack（`speakable`のみ）/ 言い方ヒント / AE better例文 / listening生成: 口語指示なし

---

### Task 1: 共通口語スタイルブロックの導入と注入

**Files:**
- Create: `app/server/spoken-style.ts`（`SPOKEN_STYLE_BLOCK` 定数 + 帯別文長ガイド関数）
- Modify: `app/server/coach.ts`（prep pack / 言い方ヒント / AE better例文のプロンプトへ注入）、`app/server/content-gen.ts`（genListening のプロンプトへ注入・帯別文長つき）
- Test: `app/server/__tests__/spoken-style.test.ts`（ブロック内容の要点）+ 既存の coach/content-gen テストにプロンプト含有アサーション追加

**Block 内容（英語・LLM向け・要点）:** 短縮形を標準とする（I'm/don't/it's）・1文は短く（帯別上限）・書き言葉語彙の禁止例（moreover/utilize/furthermore/therefore→so/and 等）・「実際に声に出して話すように書く」・リスト調や見出し調の禁止

- [ ] TDD: 注入後のプロンプトが SPOKEN_STYLE_BLOCK を含むことを既存のプロンプト構築テスト様式で先に赤→緑
- [ ] 3ゲート → Commit `feat: 口語スタイル指示ブロックを話し言葉系の生成プロンプトへ注入（prep/言い方ヒント/AE better/多聴）`

### Task 2: 口語レジスター検証スクリプト

**Files:**
- Create: `scripts/check-spoken-register.ts` + `app/server/spoken-register-check.ts`（純ロジック・テスト可能に分離）
- Test: `app/server/__tests__/spoken-register-check.test.ts`

**仕様:** 対象ファイル（多聴 md の英文本文）から ①短縮形率（短縮可能位置に対する実短縮の割合の近似でよい・実装単純さ優先で「短縮形出現数/文数」でも可）②平均文長（語/文）③書き言葉語彙ヒット（禁止リスト）を算出し、帯別閾値で PASS/FAIL を返す。**閾値は「例文300が PASS し、現行の多聴6本が FAIL する」よう較正する**（較正結果と根拠をテストに固定）。

- [ ] TDD → 3ゲート → Commit `feat: 口語レジスター検証（短縮形率・文長・書き言葉語彙）のスクリプトと純ロジック`

### Task 3: 多聴6本の再生成（検証つき）

- [ ] 現行6本の帯・トピック構成を記録 → `LLM_PROVIDER=claude CLAUDE_MODEL=opus CLAUDE_EFFORT=high` で再生成（既存ファイルの扱いは genListening の挙動を READ して確認・上書き再生成の導線が無ければ旧ファイル退避→生成）
- [ ] `bun scripts/check-spoken-register.ts` で全数 PASS まで再生成（手修正禁止）。频度caps: 3回失敗した帯はプロンプト側の問題としてTask 1へ差し戻し
- [ ] 3ゲート → Commit `feat: 多聴教材6本を口語モノローグとして再生成（機械検証PASS）`

### Task 4: ドキュメント + リリース v0.25.0

- [ ] CHANGELOG（Added: 口語スタイル統一・多聴再生成 / 検証スクリプト）+ README 該当節（多聴・カスタマイズの生成コマンド節に検証スクリプト追記）
- [ ] 最終レビュー（whole-branch・sonnet で可・小規模のため）→ マージ → タグ v0.25.0 → push → デプロイ（サーバ変更あり: build + kickstart）→ health/https 200 → 台帳・メモリ更新
