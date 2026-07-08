# desktop/ — solo-eikaiwa デスクトップシェル（Tauri v2・アタッチ方式）

macOSローカルで動く solo-eikaiwa 本体（`app/server` が `http://127.0.0.1:3111` で配信する dist）を、
ネイティブウィンドウで開くための薄いシェル。**Phase 1 ではサーバのsidecar化は行わない。**
既存のLaunchAgent常駐サーバ（`../scripts/install-daemon.sh`）または手動起動した `bun` サーバに
「アタッチ」するだけで、フロントエンドはバンドルしない。

## 前提

- macOS（Apple Silicon確認済み。他プラットフォームは未検証）
- Rust（`cargo` 1.77.2 以上。動作確認は 1.96）
- Tauri CLI: `cargo install tauri-cli --locked`（`cargo tauri --version` で確認）
- solo-eikaiwa 本体サーバが `http://127.0.0.1:3111` で起動していること（`../scripts/install-daemon.sh` 済みが前提。手動起動でも可）

## 開発

```bash
cd desktop/src-tauri
cargo tauri dev
```

frontendDistは同梱のフォールバックページ（`desktop/fallback/index.html`）のみで、
npmビルドステップは無い（`beforeDevCommand`/`beforeBuildCommand` は設定していない）。

**既知の制限**: `cargo tauri dev` は Info.plist / Entitlements.plist を適用しないバイナリを
直接起動するため、マイク権限（TCC）のプロンプトが正しく出ない/OS側の判定が本番と異なる場合がある
（[tauri-apps/tauri#15144](https://github.com/tauri-apps/tauri/issues/15144) で追跡中の既知の制約）。
マイク権限を含むE2E確認は `cargo tauri build` で生成した `.app` を直接起動して行うこと。

## ビルド

```bash
cd desktop/src-tauri
cargo tauri build --bundles app
```

生成物: `desktop/src-tauri/target/release/bundle/macos/solo-eikaiwa.app`
（署名は `signingIdentity: "-"` によるローカルad-hoc署名のみ。配布用の実証明書での署名・公証は Phase 2）

## アタッチ方式の挙動

1. 起動時にメインウィンドウは同梱のフォールバックページ（サーバ未起動時の案内。日本語+英語）を表示する。
2. バックグラウンドで `http://127.0.0.1:3111/api/health` を1秒間隔・最大5回ポーリングする。
3. 応答があれば（ステータスコードの内容は問わない）、メインウィンドウを `http://127.0.0.1:3111/` へ
   `navigate()` で切り替える。以降はTauri固有の処理は挟まらず、通常のWebアプリとして動く。
4. 5回とも応答が無ければ、フォールバックページに表示済みの「再試行」ボタンで手動リトライできる
   （`retry_attach` コマンドを叩き、成功時のみ同様にnavigateする）。

サーバのURL・ポート（`127.0.0.1:3111`）はコード内の定数（`src/attach.rs`）に固定している。
env等での可変化はしない（Phase 1の設計方針: ポート3111単一所有・アタッチ方式に徹する）。

## macOSマイク権限（getUserMedia）に関する調査結果

WKWebView上の `navigator.mediaDevices.getUserMedia` がmacOSで動くために必要な設定を実装済み:

- `src-tauri/Info.plist`: `NSMicrophoneUsageDescription`（TCCのマイク許可プロンプトに表示される文言）。
  Tauriが自動でバンドルの `Info.plist` にマージする（公式ドキュメント記載の挙動、tauri.conf.json側の配線は不要）。
- `src-tauri/Entitlements.plist`: `com.apple.security.device.audio-input = true`。
  `tauri.conf.json` の `bundle.macOS.entitlements` で参照。
- `tauri.conf.json` の `bundle.macOS.signingIdentity: "-"`: これが無いと、Tauriのビルド時署名処理
  自体がスキップされ（`signingIdentity` 未設定時は無条件でスキップされる実装になっている）、
  Entitlements.plist が一切適用されない。ローカル配布前提（Developer ID証明書なし）のため、
  ad-hoc署名（`-`）を明示指定して署名ステップを強制的に走らせている。
- `hardenedRuntime` はTauriの既定値（`true`）のまま変更していない。
  Hardened Runtime + audio-inputエンタイトルメントの組み合わせが、コミュニティで実際に動作確認された
  組み合わせだったため（[tauri-apps/tauri#11951](https://github.com/tauri-apps/tauri/issues/11951) のコメント）。

**重要な既知の制限（Task 3のPoCに影響）**: これらの署名・Info.plistマージは `cargo tauri build` の
バンドル生成時にのみ適用され、`cargo tauri dev` では適用されない
（[tauri-apps/tauri#15144](https://github.com/tauri-apps/tauri/issues/15144)、Tauri側で対応中・未マージ）。
そのため、マイク権限を含む録音PoC（Task 3）は、`cargo tauri build` でビルドした `.app` を
直接起動して検証する必要がある。`cargo tauri dev` でのマイク権限プロンプトは信頼できない。

検証済み: `cargo tauri build --bundles app` で生成した `.app` に対して
`codesign -d --entitlements :-` を実行し、`com.apple.security.device.audio-input` が
実際に署名へ埋め込まれていることを確認済み（`flags=0x10002(adhoc,runtime)`）。
実機でのマイク許可ダイアログ表示・録音成功までは未確認（Task 3のスコープ）。
