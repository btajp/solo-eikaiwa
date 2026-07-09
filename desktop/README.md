# desktop/ — solo-eikaiwa デスクトップシェル（Tauri v2・attach-first + sidecar同梱）

macOSローカルで動く solo-eikaiwa 本体をネイティブウィンドウで開くTauriシェル。**Tauri Phase 2**
でサーバ本体（`bun build --compile`）・whisper-cli・content・クライアントdistを`.app`に同梱し、
DLするだけで動く単体配布アプリを実現した。開発者のLaunchAgentデーモンが`127.0.0.1:3111`で
稼働中ならそれにアタッチ（attach-first、Phase 1由来の挙動）し、いなければ同梱サーバを自前で
起動する（sidecar、配布ユーザーは実質常にこちら）。詳細は「起動方式（attach-first + sidecar）」
節を参照。

## 前提

- macOS（Apple Silicon確認済み。他プラットフォームは未検証）
- Rust（`cargo` 1.77.2 以上。動作確認は 1.96）
- Tauri CLI: `cargo install tauri-cli --locked`（`cargo tauri --version` で確認）
- Bun（サーバのcompileに使う）
- Homebrew + `brew install whisper-cpp`（whisper-cli本体・ggml・libompの収集元。配布物には
  同梱するので配布先ユーザーはHomebrew不要）
- （devモードでアタッチ先を用意する場合のみ）solo-eikaiwa 本体サーバが `http://127.0.0.1:3111` で
  起動していること（`../scripts/install-daemon.sh` 済みが前提。手動起動でも可）

## 開発

**先に `./desktop/build-sidecar.sh` を1回実行すること。** `tauri.conf.json` の
`externalBin`/`resources` が必須参照になっているため、これを実行するまでは
`cargo build`・`cargo test --lib`・`cargo tauri dev` の**すべて**が
`resource path binaries/solo-server-... doesn't exist` で失敗する（実測確認済み）。
ソースだけを軽く触ってすぐ`cargo check`したい場合も同様に事前実行が必要。

```bash
./desktop/build-sidecar.sh   # 初回・resources/binaries を作り直したい時は毎回
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
./desktop/build-sidecar.sh                       # サーバcompile + client build + content/whisper-cli収集
cd desktop/src-tauri && cargo tauri build --bundles app   # .appのみ（TCC検証等の開発用途はこちらで十分・高速）
# 配布物（dmg）を作る場合はbundles指定を外す（tauri.conf.jsonのtargets:"all"によりapp+dmgの両方が生成される）
cd desktop/src-tauri && cargo tauri build
```

`build-sidecar.sh` は冪等（毎回 `desktop/src-tauri/{binaries,resources}` を作り直す）で、
以下を行う。詳細・設計理由はスクリプト内コメントを参照:

1. `bun build --compile` でサーバを単一バイナリ化 → `binaries/solo-server-aarch64-apple-darwin`
   （Tauriのexternal binaries命名規則。ビルド時に`-aarch64-apple-darwin`が取り除かれ
   `Contents/MacOS/solo-server` として配置される）
2. クライアントをbuildして `resources/dist` へ
3. `content/` を `resources/content` へ
4. brewのwhisper-cli本体・依存dylib4本・ggmlバックエンドプラグイン.so 5本を集め、
   `install_name_tool` でHomebrewへの絶対パス依存を`@rpath`に書き換えてから
   `resources/whisper-bin` へ配置（配布先にHomebrewが無くても動くようにするため）

**whisperモデル本体（`ggml-*.bin`、0.5〜1.6GB）はここに含まれない**。配布物のサイズを抑えるため、
モデルはアプリの初回起動時にユーザーが選んでダウンロードする設計（`app/server/model-download.ts`・
`app/server/routes/setup.ts`）にしており、ビルド時同梱はしていない。

生成物: `desktop/src-tauri/target/release/bundle/macos/solo-eikaiwa.app`（190MB程度。
サーバ本体64MB+content113MB+whisper-bin5MB+シェル8MB）。`cargo tauri build`（bundles指定なし）
まで実行すると同ディレクトリの`bundle/dmg/`に配布用dmgも生成される。
署名は `signingIdentity: "-"` によるローカルad-hoc署名のみ（配布用の実証明書での署名・公証は未実施。
現状はad-hoc署名のまま配布している）。

`binaries/` `resources/` はどちらもビルド生成物のため gitignore 済み（コミット対象外）。

## 起動方式（attach-first + sidecar）

1. 起動時にメインウィンドウは同梱のフォールバックページ（サーバ未起動時の案内）を表示する。
2. **attach**: `SOLO_EIKAIWA_NO_ATTACH` が未設定なら、`http://127.0.0.1:3111/api/health` を
   300ms間隔・最大2回だけ短くポーリングする。応答のJSONボディに `"app":"solo-eikaiwa"` が
   含まれていれば（身元確認）、既存デーモンとみなしてそのまま `navigate()` する。
   身元確認まで含めているのは、別アプリ/別サービスがたまたま3111を掴んでいた場合に誤接続しない
   ため（health応答の`app`/`version`フィールドは`app/server/health.ts`が返す）。
3. **own sidecar**: attachが失敗した場合（配布ユーザーは常にこちら）、または
   `SOLO_EIKAIWA_NO_ATTACH=1` の場合、同梱の`solo-server`をspawnする。
   - env注入: `SOLO_EIKAIWA_RESOURCES_DIR`（`.app`のResourcesディレクトリ）・
     `SOLO_EIKAIWA_DATA_DIR`（Tauriの`app_data_dir()` = `~/Library/Application Support/<bundle-id>`）・
     `SOLO_EIKAIWA_PORT`・`PATH`（同梱whisper-cliを最優先しつつ、`zsh -lc`でユーザーのログイン
     シェルの`$PATH`を取得して土台にする。GUI起動アプリは`/usr/bin:/bin`程度の最小PATHしか
     継承しないため、brew/npm/公式インストーラのどこに入っていてもclaude/codexを`Bun.which()`で
     解決できるようにするため。`scripts/daemon-server.sh`と同じ狙い）
   - ポート競合フォールバック: 3111が使用中だと`app/server`側が`process.exit(1)`する設計
     （既存デーモンの有無に関わらず、EADDRINUSEなら即終了）に乗って検知し、子プロセスが
     健康になる前に終了した場合のみ3112へ1回だけリトライする
   - 標準出力・標準エラーはタイムスタンプつきで `<DATA_DIR>/logs/sidecar.log` に追記する
   - 身元確認つきヘルスチェックが通ったら `navigate()` する
4. 全滅した場合はフォールバックページの「再試行」ボタン（`retry_attach`コマンド、attach→own sidecar
   の同じ流れを再実行する）でリトライできる。
5. **アプリ終了時**: 自前spawnした子プロセスは`RunEvent::Exit`でkillする（Cmd+Q・メニューの
   「終了」等、通常の終了操作で確認済み）。**既知の制限**: Force Quit（SIGKILL）やOS再起動時の
   SIGTERM等、アプリ側にイベントが届かない強制終了では子プロセスがorphan化し得る
   （SIGKILLはシグナルハンドラで捕捉不可能なため原理的に防げない。ただしattach-firstの設計上、
   次回起動時にorphan化したsidecarへ身元確認つきでアタッチし直すため実害は小さい）。

サーバのポート（既定3111・フォールバック3112）は `src/sidecar.rs` の定数。
env等でのユーザー向け可変化はしない（配布物としての単純さを優先）。

## Hardened RuntimeとBunのJIT（sidecar同梱で新規に踏んだ既知の制約）

Tauriのビルド時署名は `Contents/MacOS/` 配下の全バイナリ（externalBinのsolo-serverも含む）に
同一の `Entitlements.plist` を適用する。`bun build --compile` で作った単体バイナリは内蔵JS
エンジンが実行時にJIT用メモリ（`SharedArrayBuffer`含む）を確保するため、Hardened Runtime既定の
ままだと `ReferenceError: SharedArrayBuffer is not defined` で即クラッシュする
（`.app`から直接execした場合のみ再現。`bun build --compile`直後の生バイナリを単体で動かす分には
問題ない＝Hardened Runtimeでの署名が原因と特定済み、2026-07-09実機確認）。
`Entitlements.plist`に以下を追加して解消した（Node/Bun/Deno系ランタイムをHardened Runtime配下の
macOSアプリに同梱する際の既知要件）:

```xml
<key>com.apple.security.cs.allow-jit</key><true/>
<key>com.apple.security.cs.allow-unsigned-executable-memory</key><true/>
<key>com.apple.security.cs.disable-library-validation</key><true/>
```

（entitlements plistのXMLパーサ`AMFIUnserializeXML`はコメントノードを許容しないため、
このファイル自体にはコメントを書けない。理由はこちらに記録する。）

## whisper-cliの同梱（隠れた依存: ggmlバックエンドプラグイン）

whisper-cliは本体+4dylib（`libwhisper.1`/`libggml.0`/`libggml-base.0`/`libomp`）に加えて、
Mach-Oのロードコマンドには現れない**隠れた依存**を持つ: ggml自身が起動時に`dlopen()`で
Metal/CPU/BLASの実装（`libggml-{metal,cpu-apple_*,blas}.so`）を探しに行く
（[ggml-org/ggml `ggml-backend-reg.cpp`](https://github.com/ggml-org/ggml/blob/master/src/ggml-backend-reg.cpp)
の`ggml_backend_load_best`）。検索順は「ビルド時に焼き込まれた絶対パス
（brewビルドでは`/opt/homebrew/Cellar/...`。配布先に存在しないので自動的にスキップされる）」
→「実行ファイル自身のディレクトリ」→「カレントディレクトリ」。つまりbackend `.so`は
whisper-cliの実行ファイルと同階層に置く必要がある（`lib/`に置いても見つからない）。
`build-sidecar.sh`はこれを踏まえて`resources/whisper-bin/`直下に配置している。

## STT変換: ffmpeg非同梱・afconvertへの切替

配布物にffmpegは同梱していない。`app/server/stt.ts`は変換器をffmpeg優先で選択し、無ければmacOS標準の
`afconvert`（`audio/mp4`/`m4a`/`mp3`のみ対応・`audio/webm`は明示エラー）にフォールバックする設計に
なっている。sidecarではffmpegを同梱しないため常にafconvert経路になる。これを成立させるため、
クライアント側の録音（`app/client/src/audio.ts`）はTauriデスクトップシェル内（UA文字列
`solo-eikaiwa-desktop`で判定）でのみ`MediaRecorder`のmimeTypeを`audio/mp4`優先にする
（ブラウザ版は従来どおり`audio/webm`固定・挙動不変）。変換対象は録音完了後の単一Blobのみで、
`timeslice`を使ったチャンク単位の変換は行わない。

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
