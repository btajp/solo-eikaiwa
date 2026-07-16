# デスクトップアプリ 署名・公証 + 半自動アップデート 設計ドキュメント（v0.29 候補）

- 起点: ユーザー指示（2026-07-09）「デスクトップアプリに自動アップデートをつけたい。署名を先にやってもいい」
- 前提リリース: v0.28.0 Tauri Phase 2（単体配布 dmg・ad-hoc 署名・自動更新なし・About に手動導線のみ）
- ユーザー確認済みの決定: **Apple Developer Program は BTAJP 組織名義で加入済み** / 更新 UX は**半自動**（チェック→通知→1クリック更新）/ リリースは**ローカルスクリプト**（CI 化しない）/ 実装方式は **tauri-plugin-updater**（公式）

## 1. 解くべき問題

1. 配布 dmg が ad-hoc 署名のみで、初回起動に Gatekeeper 回避手順（システム設定→このまま開く）が必要（README に手順を掲載して回避中）
2. ad-hoc 署名（Team ID なし）により、**マイク許可ダイアログの請求元表示が起動系譜のターミナル名になる**既知問題（desktop/README「マイク許可ダイアログは必ずFinderから」節・Developer ID 署名で解消見込みと記録済み）
3. 更新手段が「GitHub Releases から dmg を手動 DL → 手動差し替え → Gatekeeper 手順を再度実施」しかなく、更新のたびに導入時と同じ摩擦が発生する

## 2. 全体構成（2段構え・A が B の前提）

- **Phase A: Developer ID 署名 + 公証** — 単独でも問題 1・2 を解消する独立価値がある
- **Phase B: tauri-plugin-updater 組み込み** — 問題 3 を解消。署名済み配布が前提

> **2026-07-17 改訂注記（§2）**: 実際のリリース順序は本節の前提と逆になった。Apple 証明書の発行待ち（Account Holder 対応待ち — [docs/apple-account-holder-request.md](../../apple-account-holder-request.md) 参照）のため、**v0.29.0 は Phase B（updater）のみを ad-hoc 署名・未公証で先行リリース**し、**Phase A（Developer ID 署名・Apple 公証・staple）は v0.29.1 で完了**した。以後の GitHub Releases は署名・公証済み配布が標準経路（AGENTS.md「Apple・デスクトップ公開」・README「起動: デスクトップアプリ（Tauri）」参照）。ad-hoc 版 v0.29.0 から v0.29.1 へ更新した際のマイク許可再確認は README に注記済み。

## 3. Phase A: 署名・公証

- **ユーザーにしか実施できない準備**（実装計画に手順を明記し、最初のタスクにする）:
  1. BTAJP の Apple Developer アカウントで **Developer ID Application 証明書**を作成し、ビルドマシンの Keychain へ導入
  2. 公証用の **App Store Connect API キー**（.p8・Issuer ID・Key ID）を発行しローカル保存
- **リポジトリの `tauri.conf.json` は `signingIdentity: "-"` のまま変更しない**。開発ビルド・証明書を持たない環境のビルドは従来どおり ad-hoc で成立させる。リリース時のみ環境変数で上書きする（Tauri bundler の仕様: `APPLE_SIGNING_IDENTITY` が設定値より優先・公証は `APPLE_API_KEY`/`APPLE_API_ISSUER`/`APPLE_API_KEY_PATH` の設定時に自動実行）
- dmg・.app の両方を署名・公証・staple し、`spctl -a -t exec -vv` と検疫属性付き実機起動で Gatekeeper 素通りを検証する
- ドキュメント更新: README・desktop/README・site（LP）の Gatekeeper 回避手順を削除し署名済み配布の記述へ。desktop/README の TCC 節は実測結果で更新
- **既知の影響（CHANGELOG・リリースノートに注記）**: 署名の変更（ad-hoc→Developer ID）により、既存ユーザーの TCC マイク許可は再要求される可能性が高い（TCC.db は署名要件に紐づくため）
- **スパイクで実証してから本実装に入る事項**: Hardened Runtime + JIT 系エンタイトルメント3種（bun compile バイナリの既知要件・desktop/README 記載）を含む公証が通ること

## 4. Phase B: 半自動アップデート

- 依存追加: `tauri-plugin-updater` v2 + `tauri-plugin-dialog` v2。新モジュール `desktop/src-tauri/src/updater.rs`
- **起動時に非ブロッキングでチェック**（attach/sidecar 起動と並行・起動もアプリ利用も一切ブロックしない）
  - 新版あり → ネイティブダイアログ「solo-eikaiwa vX.Y.Z が利用可能です（現在 vA.B.C）。今すぐ更新しますか?」→ OK: DL→差し替え→自動 relaunch / キャンセル: 何もしない（記録もペナルティもなし。次回起動時に再度1回だけ通知）
  - ダイアログ文言はシステムロケールで日英切替（判定ロジックは純関数に切り出し `cargo test` 対象にする）
- アプリメニューに「アップデートを確認…」を1項目追加（手動再チェック。結果は「最新です」/「vX.Y.Z があります」の情報ダイアログ）
- **Tauri IPC はゼロ権限を維持**: 更新 UI はネイティブダイアログのみ。Web 画面（localhost:3111 配信の本体 UI）には更新機能を露出せず、`capabilities/default.json` は変更しない（Phase 2 のセキュリティ判断「attached app origin に IPC を渡さない」を継承）
- 更新アーティファクト署名: **Tauri updater 専用の minisign 鍵ペアを新規生成**（`cargo tauri signer generate`）。公開鍵は `tauri.conf.json` の `plugins.updater.pubkey` にコミット（公開情報）。秘密鍵とパスワードはローカルのみ（リポ・GitHub に置かない）
- エンドポイント: `https://github.com/btajp/solo-eikaiwa/releases/latest/download/latest.json`（`releases/latest` は prerelease を含まないため、検証用 prerelease を切っても配布ユーザーに流れない）
- sidecar との整合: relaunch は既存の `RunEvent::Exit` → `kill_on_exit` に乗るため追加配線不要。attach モード（開発者デーモン接続時）でもシェル自体の更新として同様にチェックする
- **v0.28.0 以前からの移行**: updater 非搭載のため自動更新は届かない。v0.29.0 リリースノートに「今回のみ手動 DL・以後は自動」と明記

## 5. リリースフロー（`scripts/release-desktop.sh` 新設）

1. バージョン整合チェック: `app/package.json`・`desktop/src-tauri/Cargo.toml`・`desktop/src-tauri/tauri.conf.json`・引数のタグの4点一致を検証（不一致なら即エラー）
2. `desktop/build-sidecar.sh`
3. `cargo tauri build` — env 注入: Apple 署名 identity・公証 API キー・`TAURI_SIGNING_PRIVATE_KEY`（updater）。`bundle.createUpdaterArtifacts: true` により `.app.tar.gz` + `.sig` が生成され、公証は bundler が自動実行
4. `latest.json` 生成（version・pub_date・`darwin-aarch64` の url + signature）
5. `gh release create vX.Y.Z` — dmg + `.app.tar.gz` + `latest.json` を添付
6. 事後スモーク手順を出力（検疫付き dmg 起動確認・旧版からの実機更新確認）

鍵・証明書・API キーは一切リポジトリ・GitHub Secrets に置かない（ユーザー選択: ローカル完結）。

## 6. エラー処理（研究制約準拠: 情報的トーンのみ）

- チェック失敗（オフライン・GitHub 不達・レート制限）: ログのみで無言スキップ。ダイアログを出さない
- DL・適用失敗（App Translocation・読み取り専用ボリューム・書き込み権限なし等）: 情報ダイアログで Releases の手動 DL URL を案内（警告調・再試行の強要なし）

## 7. テスト・検証

- `cargo test`: ロケール→文言選択・ダイアログ分岐の純関数
- **E2E スパイク（リリース前必須・実装計画のタスクにする）**: ローカル HTTP サーバに `latest.json` を置き endpoint を差し替えた検証ビルドで、旧→新の実機更新を1回通す。更新後の起動・署名検証・マイク許可（TCC 請求元表示が solo-eikaiwa になるか）を実測
- 検証ゲート3種（bun test / typecheck / client build）は規約どおり実行（server/client 変更は原則ないが規約準拠）

## 8. スコープ外

- メニューバー常駐・sidecar 常駐化（Tauri Phase 3 候補として別計画）
- Intel (x86_64) 対応・ユニバーサルバイナリ
- リリースの CI 化（将来必要になったら本スクリプトを土台に移行）
- 更新チェックの opt-out 設定 UI（要望が出たら検討。現状は起動時1回チェックのみで通信も GitHub のみ）

## 9. 残リスク（実装計画のスパイクで先に潰す）

1. Hardened Runtime + JIT エンタイトルメント3種を含む公証の成立（拒否された場合はエンタイトルメント構成の再検討が必要）
2. 公証済みアプリを tauri-plugin-updater で差し替えた後の Gatekeeper/署名検証挙動（quarantine なしのため素通りの想定だが実測必須）
3. Developer ID 署名への切替で TCC 請求元表示が実際に直るか（desktop/README の推論の検証）
