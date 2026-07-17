# desktop/ — solo-eikaiwa デスクトップシェル（Tauri v2・検証付きsidecar再利用）

macOSローカルで動く solo-eikaiwa 本体をネイティブウィンドウで開くTauriシェル。**Tauri Phase 2**
でサーバ本体（`bun build --compile`）・whisper-cli・content・クライアントdistを`.app`に同梱し、
DLするだけで動く単体配布アプリを実現した。通常は同梱サーバを自前で起動し、Force Quit等で
残ったsidecarだけを版・出所・データ領域の完全一致を確認して再利用する。開発用のLaunchAgentや
別版のサーバには接続しない。詳細は「起動方式（検証付きsidecar再利用）」節を参照。

## 前提

- macOS 13.3以降（Apple Silicon確認済み。他プラットフォームは未検証）
- Rust（`cargo` 1.77.2 以上。動作確認は 1.96）
- Tauri CLI 2.11.4: `cargo install tauri-cli --version 2.11.4 --locked`
- cargo-audit 0.22.2: `cargo install cargo-audit --version 0.22.2 --locked`（release依存監査用）
- Bun 1.3.14（サーバのcompileに使用。期待版は`../toolchain.json`が正本）
- CMake 3.25以上（固定したwhisper.cpp sourceのビルドに使用。スクリプトは自動導入しないため、
  既存の開発環境管理経路で用意する。配布先ユーザーには不要）

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
./desktop/build-sidecar.sh                       # サーバcompile + client build + fixed whisper source + provenance
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
4. `native-deps.lock.json` で固定したwhisper.cpp sourceをSHA-256検証後にstaticビルドし、
   `resources/whisper-bin` へ配置（Homebrewの動的ライブラリは同梱しない）
5. Bun・Rust・native source・教材・生成物を記録したSBOM、第三者NOTICE、ライセンス本文を
   `resources/provenance` へ生成

**whisperモデル本体（`ggml-*.bin`、0.5〜1.6GB）はここに含まれない**。配布物のサイズを抑えるため、
モデルはアプリの初回起動時にユーザーが選んでダウンロードする設計（`app/server/model-download.ts`・
`app/server/routes/setup.ts`）にしており、ビルド時同梱はしていない。

生成物: `desktop/src-tauri/target/release/bundle/macos/solo-eikaiwa.app`（およそ195MB。
サーバ本体64MB+content113MB+whisper-bin3MB+provenance4MB+シェル8MB）。`cargo tauri build`（bundles指定なし）
まで実行すると同ディレクトリの`bundle/dmg/`に配布用dmgも生成される。
署名は、**開発ビルド（上記コマンド）では `signingIdentity: "-"` によるad-hoc署名**（証明書不要・
従来どおり）、**標準の配布リリースでは Developer ID 署名 + Apple 公証**
（`../scripts/release-desktop.sh` が環境変数で注入する。後述「署名・公証・リリース」節参照）。
v0.29.0 の公開物だけは証明書準備を後回しにした例外で、ad-hoc署名・未公証として提供した。
v0.29.1以降の標準配布はDeveloper ID署名・Apple公証済みとする。

`binaries/` `resources/` はどちらもビルド生成物のため gitignore 済み（コミット対象外）。

## 署名・公証・リリース（v0.29.0〜）

v0.29.0 は例外的にad-hoc署名・未公証で公開した。v0.29.1以降は以下の標準経路を使い、
署名・公証の検証を省略しない。

配布リリースは `../scripts/release-desktop.sh <version>` の一括実行（**push 済みの main からのみ**実行可能。
タグはリモートに作られるため、未 push だとタグ・Source とバイナリが食い違う — スクリプトが強制チェックする）:
検証ゲート → build-sidecar → **whisper-bin プレ署名** → `cargo tauri build`（Developer ID 署名 +
公証を bundler が env から自動実行・updater アーティファクト生成）→ 署名/公証の機械検証 →
dmg の公証 + staple → `latest.json` 生成 → SBOM・NOTICE・依存監査・checksum・provenance生成 →
GitHub Release（draft→publish）。

- **シークレットはすべてリポジトリ外**の `~/.config/solo-eikaiwa/release.env` から注入する
  （初回実行時にテンプレートを自動生成。Developer ID 証明書名・App Store Connect API キー・
  updater 秘密鍵のパス）。リポジトリの `tauri.conf.json` は `signingIdentity: "-"` のままで、
  リリース時のみ `APPLE_SIGNING_IDENTITY` 環境変数が上書きする（env var 優先は tauri-cli 仕様）
- **whisper-bin のプレ署名が必須な理由**: tauri-bundler は `Contents/Resources/` 配下の
  Mach-O（static `whisper-cli`）を署名対象にしない（bundler 2.9.4 ソース実測）。
  未署名の Mach-O が残ると公証が必ず落ちるため、リリーススクリプトがビルド前に
  `codesign --options runtime --timestamp` で個別署名し、署名後のhashでnative manifestとSBOMを再生成する
- **updater 署名鍵**（`~/.tauri/solo-eikaiwa-updater.key`・minisign・Apple とは別物）:
  公開鍵は `tauri.conf.json` の `plugins.updater.pubkey` にコミット済み。
  **秘密鍵を失うと既存ユーザーへ自動更新を届ける手段が永久に失われる**ので必ずバックアップする。
  リリース前には `.app.tar.gz` と `.sig` を、実行時と同じ検証器で照合する。設定鍵・署名鍵・直前リリースの鍵が通常リリースで一致しなければ公開しない
- **鍵ローテーション**: 既存利用者へ新鍵を配るには、まず `tauri.conf.json` を新公開鍵へ変更しつつ、
  **旧秘密鍵**で署名した橋渡し版を `../scripts/release-desktop.sh <version> --allow-pubkey-rotation` で公開する。
  その版を受け取ったアプリだけが新鍵を内包するため、次のリリースから新秘密鍵で通常どおり署名する。
  新鍵で直接署名したり、フラグなしで鍵を変えたりすると旧版が更新を検証できないため、スクリプトが中断する
- `createUpdaterArtifacts` は本体 config に入れず `tauri.updater-artifacts.conf.json`（overlay）
  でリリース/E2E時のみ有効化する（有効時に署名鍵 env が無いとビルド自体が失敗するため、
  開発ビルドを巻き込まないようにする設計。2026-07-10 実測）
- 更新フローの実機E2E（Apple 資格情報不要・ad-hoc のまま検証可能）は `e2e-updater/README.md`
- Releaseにはアプリ内と同一のSBOM・第三者NOTICE・ライセンスアーカイブ、native lock/manifest、
  依存監査結果、artifact checksum、provenance JSONを添付する。公開前にそれぞれのSHA-256と
  `.app`内の対応ファイルを照合する

## 自動アップデートの仕組み（v0.29.0〜）

起動時に `https://github.com/btajp/solo-eikaiwa/releases/latest/download/latest.json` を
非ブロッキングで最大30秒チェックし、新版があればネイティブダイアログで案内する。「更新する」で
DL → minisign 署名検証 → `.app` 差し替えへ進む。確認中・ダウンロード中（Content-Length がある場合は
進捗率）・適用中はアプリメニュー「アップデートを確認…」の表示を切り替え、処理中は同項目を無効化する。
ダウンロードが90秒間まったく進まない場合、または通信全体が20分を超えた場合は中断し、手動DLを案内する。
適用後は再起動前に必ず確認し、「あとで再起動」を選んだ場合はメニューから再起動確認を開ける。チェック失敗
（オフライン等）は起動時はログのみで無言スキップし、手動時は確認できなかったことを表示する。
更新UI（`src/updater.rs`）はすべて Rust 側で完結し、**本体UI（localhost配信のwebview）への
IPC はゼロ権限のまま**（`capabilities/default.json` の方針を維持）。

再起動は非メインスレッドからの `app.restart()` で行い、`RunEvent::Exit` → `sidecar::kill_on_exit`
の既存経路を通るため、自前spawnした旧 sidecar は終了してから新バージョンが起動する（現行 Cargo.lock の
tauri 2.11.5 / tauri-plugin-updater 2.10.1。tauri 2.11.5 ソースで、非メインスレッドからの
`restart()` が `RunEvent::Exit` を経由することを確認済み）。attach再利用中（子プロセスとして
持っていない）のsidecarはこの経路では終了しないが、再起動後の起動フローが「自分の旧sidecar」
として回収する（下記「own sidecar」の回収ステップ・#270）。適用失敗（App Translocation = `/Applications` 未移動が典型）は Releases への
手動DL案内を情報的トーンで表示する。実行パスに symlink が含まれると updater が拒否する点に注意
（`/tmp` 配下での検証は実パス `/private/tmp` を使う。`e2e-updater/README.md` 参照）。

## 起動方式（検証付きsidecar再利用）

1. 起動時にメインウィンドウは同梱のフォールバックページ（サーバ未起動時の案内）を表示する。
2. **verified reuse**: データ領域に永続instance IDを初回だけ作り、正規化したデータ領域の
   SHA-256 IDと合わせて期待値を組み立てる。候補ポート3111〜3114（`src/sidecar.rs` の
   `CANDIDATE_PORTS`）のhealthを短く確認し、`app`・アプリ版・
   handshake protocol・同梱サーバ本体のSHA-256 build ID・データ領域ID・instance IDがすべて一致するsidecarだけを再利用する。
   生のデータ領域パスはhealthへ返さない。開発サーバ、旧版、別データ領域、偽healthはfail-closedで
   拒否するため、LaunchAgentが3111で動いていてもデスクトップ版はそこへ接続しない。
3. **own sidecar**: 再利用できるsidecarが無い場合、または
   `SOLO_EIKAIWA_NO_ATTACH=1` の場合、同梱の`solo-server`をspawnする。
   - 旧own-sidecarの回収（#270）: spawn前に候補ポートを確認し、「Stale判定かつデータ領域ID・
     instance IDが自分と一致する」= 自分が過去に起動した旧バージョンのsidecarに限り、
     `lsof`でLISTEN中のpidを解決してSIGTERMで回収する（自動更新は`.app`だけを差し替えるため、
     attach再利用中だった旧sidecarは更新後も既定ポートで旧バージョンのまま生き残る問題への対処）。
     他人のプロセス・開発サーバ・別データ領域のsidecarには触れない。`SOLO_EIKAIWA_NO_ATTACH=1`
     の場合は回収も行わない
   - env注入: `SOLO_EIKAIWA_RESOURCES_DIR`（`.app`のResourcesディレクトリ）・
     `SOLO_EIKAIWA_DATA_DIR`（Tauriの`app_data_dir()` = `~/Library/Application Support/<bundle-id>`）・
     `SOLO_EIKAIWA_PORT`・上記4種のsidecar識別値・`PATH`（同梱whisper-cliを最優先しつつ、`zsh -lc`でユーザーのログイン
     シェルの`$PATH`を取得して土台にする。GUI起動アプリは`/usr/bin:/bin`程度の最小PATHしか
     継承しないため、brew/npm/公式インストーラのどこに入っていてもclaude/codexを`Bun.which()`で
     解決できるようにするため。`scripts/daemon-server.sh`と同じ狙い）
   - ポート競合フォールバック: 使用中のポートでは`app/server`側が`process.exit(1)`する設計
     （既存プロセスの種類に関わらず、EADDRINUSEなら即終了）に乗って検知し、子プロセスが
     健康になる前に終了した場合は候補ポート3111〜3114を順に次へ切り替えて再試行する
   - 標準出力・標準エラーはタイムスタンプつきで `<DATA_DIR>/logs/sidecar.log` に記録する。
     5 MiBで切り替え、現行＋`.1`〜`.3`（最大20 MiB）を保持する。rotation中も子プロセスは
     継続し、APIキー・認証header・発話本文を示す行は保存前にredactする
   - 身元確認つきヘルスチェックが通ったら `navigate()` する
4. 全滅した場合はフォールバックページで、互換性のない旧sidecarと一般的なポート占有を区別して
   案内する。「再試行」ボタンは同じ確認→起動の流れを再実行する。
5. **アプリ終了時**: 自前spawnした子プロセスは`RunEvent::Exit`でkillする（Cmd+Q・メニューの
   「終了」等、通常の終了操作で確認済み）。**既知の制限**: Force Quit（SIGKILL）やOS再起動時の
   SIGTERM等、アプリ側にイベントが届かない強制終了では子プロセスがorphan化し得る
   （SIGKILLはシグナルハンドラで捕捉不可能なため原理的に防げない。同一ビルド・同一データ領域の
   orphanだけは次回起動時に再利用し、更新前の旧sidecarは拒否して新しいsidecarを起動する）。

サーバの候補ポート（既定3111・使用中なら3112〜3114へ順にフォールバック）は `src/sidecar.rs` の
定数 `CANDIDATE_PORTS`。env等でのユーザー向け可変化はしない（配布物としての単純さを優先）。

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

## whisper-cliの同梱（固定source・staticビルド）

`desktop/native-deps.lock.json` は whisper.cpp の版・commit・HTTPS source URL・SHA-256・Apple Silicon向け
build引数を固定する正本である。`build-native-whisper.sh` はarchiveを取得後にhash不一致なら停止し、
Metal/Accelerateを有効にしたstatic `whisper-cli` だけを生成する。OpenMPと動的ggml backendは無効なので、
Homebrewの`ggml`/`libomp`や`.dylib`/`.so`を配布物へ持ち込まない。

ビルド後は`whisper-cli --help`と`otool -L`を検査し、macOSのsystem framework以外の動的依存が残れば停止する。
`native-dependencies.json`にはsource lockのSHA-256、実測CMake/compiler/SDK、artifact SHA-256を保存し、
同梱のMIT license textとともに追跡できるようにする。

SBOMには、単体サーバへ埋め込むBun runtimeとデスクトップを構築するRust toolchainも明示する。各runtimeの
ライセンス本文は `third-party-licenses/` に固定したupstream sourceから取り込み、配布物の
`Resources/provenance/licenses` とReleaseのライセンスアーカイブへ同梱する。

## STT変換: ffmpeg非同梱・afconvertへの切替

配布物にffmpegは同梱していない。`app/server/stt.ts`は変換器をffmpeg優先で選択し、無ければmacOS標準の
`afconvert`（`audio/mp4`/`m4a`/`mp3`のみ対応・`audio/webm`は明示エラー）にフォールバックする設計に
なっている。sidecarではffmpegを同梱しないため常にafconvert経路になる。これを成立させるため、
クライアント側の録音（`app/client/src/audio.ts`）はTauriデスクトップシェル内（UA文字列
`solo-eikaiwa-desktop`で判定）でのみ`MediaRecorder`のmimeTypeを`audio/mp4`優先にする
（ブラウザ版は従来どおり`audio/webm`固定・挙動不変）。変換対象は録音完了後の単一Blobのみで、
`timeslice`を使ったチャンク単位の変換は行わない。

## TTS変換: ffmpeg非同梱・macOS sayの直接出力

APIキーやローカルTTSが無い場合、`app/server/tts.ts` はmacOS標準の`/usr/bin/say`へ
`--data-format=aac`を指定し、ブラウザで再生できるAAC/M4Aを直接生成する。AIFFからMP3への変換や
PATH上のffmpegには依存しないため、GUI起動時の最小PATHでも動作する。OS標準コンポーネントを呼び出すだけで
追加の第三者バイナリを配布物へ同梱しないため、この経路による追加ライセンス表記も発生しない。

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
v0.29.0 の公開物もad-hoc署名のため、この節の注意がそのまま適用される。v0.29.1以降の
Developer ID署名済みリリースでの請求元表示は**未確認（2026-07-17時点）**。実機確認できるまでは、
署名済みリリースでもこの節の手順（Finderから起動して請求元を確認してから許可）をそのまま適用する。

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
