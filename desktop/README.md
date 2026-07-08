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

## マイク許可ダイアログは必ずFinderから起動して行うこと（重要・実測済みの制限）

Task 3の実機PoCで、`.app`内バイナリをターミナルから直接exec（`SOLO_EIKAIWA_POC=stt ./…/app`）した場合、
**さらに`open -na <app> --args --poc=stt`（LaunchServices経由の起動＋argv伝達）に変更した場合でも**、
macOSのマイク許可ダイアログの請求元表示が `solo-eikaiwa` ではなく起動系譜のターミナルアプリ
（実測では `Ghostty`）になる現象を確認した。`ps`でプロセス階層を追跡しても、LaunchServices経由で
起動したGUIアプリ・XPCサービスは即座にlaunchd（PID1）へ再親化されるため単純な親子関係では
判別できず、`codesign -dv`で本アプリが `Signature=adhoc` / `TeamIdentifier=not set`
（Developer ID未署名）であることも合わせて確認した。これらから、**TCCの「責任プロセス」解決が
Team ID無し署名のバイナリに対しては起動系譜のターミナルへフォールバックしている可能性が高い**
と推測している（確証ではなく推論。ad-hoc署名を卒業し正式なDeveloper ID署名にすれば解消する見込み）。

この状態で誤ってダイアログの「許可」を押すと、solo-eikaiwaではなく起動元のターミナルアプリに
永続的なマイクアクセス権が付与されてしまう（TCC.dbはクライアントのbundle-idに紐づくため）。
**そのため、初回のマイク許可は必ず Finder から `solo-eikaiwa.app` をダブルクリックして起動し、
実際の録音ボタン操作（→getUserMedia呼び出し）で表示されるダイアログに対して行うこと。**
このとき請求元が正しく「solo-eikaiwa」と表示されることを確認してから「許可」を押す。
ターミナル経由（`open`含む）で起動して表示されたダイアログの請求元が `solo-eikaiwa` 以外
（ターミナルアプリ名など）になっている場合は、絶対に「許可」を押さないこと
（`許可しない`を選ぶか、ウィンドウを閉じる。必要なら「システム設定を開く」から
プライバシーとセキュリティ＞マイクの一覧を直接確認する）。

Finderから起動して一度マイクを許可した後は、この`.app`（bundle-id: `com.local.solo-eikaiwa.desktop`）に
対する許可はTCC.dbに保存されるため、以後は通常の録音フロー（アプリ内の録音ボタン→許可済みなら
ダイアログ無しで即録音）がそのままE2E検証になる。対応mimeType一覧などのサポート行列も見たい場合は、
許可後に以下でPoCページを起動すると `data/logs/poc-stt.jsonl` へ自動記録される
（この2回目以降の起動はターミナル経由でも、bundle-id単位で既に許可済みのため問題ない）:

```bash
open -na desktop/src-tauri/target/release/bundle/macos/solo-eikaiwa.app --args --poc=stt
```
