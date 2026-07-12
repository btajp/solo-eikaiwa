# macOS 署名・公証 / Mac App Store 公開手順書

最終確認日: 2026-07-12

この手順書は、組織の Apple Developer Program において、開発担当者と Account Holder が別人である前提で使う。
Apple Account のパスワードや2要素認証コードを共有して作業してはいけない。

## 1. 最初に理解すること

配布経路は次の2つで、証明書・成果物・審査が異なる。

| 配布経路 | 利用者が入手する場所 | アプリ署名 | Apple側の処理 | 成果物 |
| --- | --- | --- | --- | --- |
| GitHub Releases | GitHub | Developer ID Application | Notary Serviceによる公証 | dmg、更新アーカイブ |
| Mac App Store | Mac App Store | Apple DistributionまたはMac App Distribution | App Store ConnectへのアップロードとApp Review | Mac Installer Distributionで署名したpkg |

Mac App Storeへ出すアプリは別途公証しない。App Storeへの提出処理に同等のセキュリティ検査が含まれる。

Account Holderを開発担当者へ移す必要はない。推奨分担は次のとおり。

| 担当 | 主な作業 |
| --- | --- |
| Account Holder | 最新契約への同意、Admin招待、App Store Connect API利用申請、Developer ID証明書の発行、有料配布時の契約 |
| 開発担当者（推奨: Admin） | CSR作成、証明書のインストール、APIキー作成、署名・公証ビルド、App ID・Store用証明書・profile、アップロード、メタデータ整備 |

Adminは広い権限を持つ。組織方針上Adminを付与できない場合は、Account Holderまたは既存AdminがApp ID、Store用証明書、
provisioning profileを作り、開発担当者にはApp ManagerまたはDeveloperと対象アプリへのアクセスを付与する。

## 2. 公開前に組織で決める項目

次の公開名は、既存iOSアプリのStore表示と揃えるため確定済みとする。

- Storeの組織名・開発元・販売元: `Business Technology Association Japan`
- アプリ内・Web等の短縮ブランド: `BTAJP`
- Copyright: `© <YEAR> Business Technology Association Japan`
- 人物名が必要な連絡先欄: `Shintaro Okamura`

Appleがmembershipの法人名から生成する表示を任意の人物名へ置き換えない。`BTAJP` や `BTA-JP` を
Storeの開発元名として新設せず、既存アプリと同じ正式表記を使う。

公開識別子とURLは次のとおり確定した。

- Mac App Store版Bundle ID: `org.btajp.solo-eikaiwa`
- GitHub配布版Bundle ID: `com.local.solo-eikaiwa.desktop`（変更しない）
- プライバシーポリシーURL: `https://btajp.github.io/solo-eikaiwa/privacy.html`
- サポートURL: `https://btajp.github.io/solo-eikaiwa/support.html`

Bundle IDを分けるため、Store版とGitHub配布版はmacOS上で別アプリ・別データ領域・別Keychain/TCC権限として扱う。
両方を同時に起動してもsidecarが競合しないよう、GitHub版は3111/3112、Store版は3211/3212を使う。
App Store Connectへbuildを一度アップロードした後はBundle IDを変更しない。

価格と配布地域はStore提出前に確定する。有料にする場合だけ、Account HolderによるPaid Apps Agreement、
税務、銀行情報の完了が必要になる。

## 3. Account Holderが最初に行う操作

### 3.1 契約とmembershipを確認する

1. Apple DeveloperとApp Store ConnectへAccount Holder本人がログインする
2. membershipが有効であることを確認する
3. Businessまたは契約画面に未同意の最新契約があれば同意する
4. 有料アプリにする場合だけPaid Apps Agreementに同意し、税務・銀行情報を完了する

最新契約が未同意だと、アプリレコード作成や提出が停止することがある。この操作はAccount Holderだけが行う。

### 3.2 開発担当者を招待する

App Store Connectの「Users and Access」で開発担当者のApple Accountを招待する。

推奨設定:

- Role: Admin
- Certificates, Identifiers & Profiles: 利用可
- Generate Individual API Keys: 利用可
- App Access: Full Access、または対象アプリ作成後に限定

招待された側は、自分のApple Accountで招待を承諾し、2要素認証を有効にする。
Account HolderのApple Accountを借りてログインしない。

### 3.3 App Store Connect APIを有効にする

App Store Connectの「Users and Access > Integrations」でAPIが未有効なら、Account Holderが「Request Access」を実行する。
これは組織ごとに一度だけ必要で、Appleの承認待ちになる場合がある。

有効化後、Account HolderまたはAdminがTeam API Keyを作成できる。開発担当者をAdminにする場合は、
API利用申請だけAccount Holderが行い、秘密鍵の生成と保管は開発担当者自身が行う方が安全。

### 3.4 Developer ID Application証明書を発行する

Developer ID Application証明書の通常発行はAccount Holderだけが行える。
秘密鍵を受け渡さずに済むよう、開発担当者のMacで作ったCSRを使う。

1. 開発担当者が「4.1 CSRを作成する」を実行する
2. Account Holderへ `.certSigningRequest` だけを渡す
3. Account Holderが「Certificates, Identifiers & Profiles > Certificates > + > Developer ID」を開く
4. 「Developer ID Application」を選択する
5. 開発担当者から受け取ったCSRをアップロードする
6. 生成された `.cer` を開発担当者へ返す

CSRを開発担当者のMacで作れば、対応する秘密鍵はそのMacのKeychainから出ない。
`.p12` やApple Accountのパスワードを共有する必要はない。

## 4. GitHub配布版をDeveloper ID署名・公証する

### 4.1 開発担当者のMacでCSRを作成する

1. 「キーチェーンアクセス」を開く
2. メニューの「キーチェーンアクセス > 証明書アシスタント > 認証局に証明書を要求」を選ぶ
3. User Email Addressに自分のApple Accountメールアドレスを入力する
4. Common Nameに識別しやすい名前を入力する
5. CA Email Addressは空欄
6. 「ディスクに保存」を選び、CSRを保存する

CSRには公開鍵が含まれる。秘密鍵は作成したMacのログインKeychainに残る。

### 4.2 証明書をインストールして確認する

Account Holderから返された `.cer` をダブルクリックし、ログインKeychainへ追加する。

確認コマンド:

```bash
security find-identity -v -p codesigning
```

次の形式のidentityが1件以上表示されることを確認する。

```text
Developer ID Application: ORGANIZATION NAME (TEAMID)
```

証明書だけが表示され、Keychainの「自分の証明書」で秘密鍵とセットにならない場合は、CSRを作ったMacが違う。
その場合は開発担当者のMacでCSRを作り直し、Account Holderに再発行を依頼する。

動作確認後は、証明書と秘密鍵を暗号化した `.p12` として組織のsecret vaultへバックアップする。
`.p12` のパスワードは別経路で保管し、リポジトリ、Issue、PR、チャットへ置かない。

### 4.3 公証・アップロード用のTeam API Keyを作成する

App Store Connectの「Users and Access > Integrations > Team Keys」でキーを作成する。

binary uploadまでならAccess roleはDeveloperを基準にし、APIでmetadataや提出まで自動化する場合だけApp Managerを検討する。
Team API Keyはアプリ単位に制限できないため、必要最小限のroleにする。

保管する値:

- Key ID
- Issuer ID
- `AuthKey_<KEY_ID>.p8`

`.p8` は一度しかダウンロードできない。リポジトリ、Issue、PR、チャットへ貼らず、アクセス制御された場所へ保管する。
不要になったキーはApp Store Connectからrevokeする。

### 4.4 release.envを設定する

標準リリーススクリプトを初回実行すると、リポジトリ外にテンプレートが作られる。

```bash
./scripts/release-desktop.sh 0.29.1
```

テンプレートへ次を設定する。

```bash
APPLE_SIGNING_IDENTITY="Developer ID Application: ORGANIZATION NAME (TEAMID)"
APPLE_API_KEY="KEYID"
APPLE_API_ISSUER="ISSUER-UUID"
APPLE_API_KEY_PATH="$HOME/.appstoreconnect/private_keys/AuthKey_KEYID.p8"
TAURI_SIGNING_PRIVATE_KEY="$HOME/.tauri/solo-eikaiwa-updater.key"
TAURI_SIGNING_PRIVATE_KEY_PASSWORD="UPDATER_KEY_PASSWORD_OR_EMPTY"
```

設定ファイルと秘密鍵は所有者だけが読める権限にする。
Developer ID秘密鍵、Team API Key、updater秘密鍵は役割が異なるため、それぞれ暗号化して組織管理下へバックアップする。

```bash
chmod 600 "$HOME/.config/solo-eikaiwa/release.env"
chmod 600 "$HOME/.appstoreconnect/private_keys/AuthKey_KEYID.p8"
```

### 4.5 署名済みReleaseを作る

公開済みのv0.29.0のassetは置き換えず、Developer ID署名・公証済みのv0.29.1を新規公開する。

1. package、Tauri、Cargo、CHANGELOGのversionを同じ値へ更新する
2. READMEとCHANGELOGにDeveloper ID署名への切替とマイク許可再要求の可能性を記載する
3. PRを作成し、必須CIとレビューを通してmainへmergeする
4. push済みでcleanなmainへ同期する
5. 次を実行する

```bash
./scripts/release-desktop.sh 0.29.1
```

このスクリプトはrelease検証、sidecar/native build、Developer ID署名、公証、staple、更新署名、
SBOM・依存監査・checksum・provenance、GitHub Release公開までを一括で行う。
Tauriのdmg生成はFinder AppleScriptへ依存しないCI経路を使うため、Automation権限やFinderの状態に左右されない。
この経路ではdmg内のアイコン位置装飾を省略するが、アプリ、Applicationsリンク、署名、公証には影響しない。

### 4.6 公開後の実機確認

別ディレクトリへGitHubからdmgを実ダウンロードし、次を確認する。

```bash
codesign --verify --deep --strict --verbose=2 /Applications/solo-eikaiwa.app
spctl -a -t exec -vv /Applications/solo-eikaiwa.app
xcrun stapler validate /Applications/solo-eikaiwa.app
```

確認項目:

- `spctl` が `accepted` を返す
- AuthorityがDeveloper ID Applicationで、TeamIdentifierが組織のTeam ID
- appとdmgのstaple検証が成功する
- Finderから初回起動してGatekeeper警告が出ない
- 録音、STT、sidecar、更新確認が動く
- ad-hoc署名版からの初回更新後、マイク許可を再要求される可能性を確認する

## 5. Mac App Store公開前に必要な実装

Mac App Store版は、現在のGitHub配布版をそのままpkg化して提出できない。
AppleはMac App StoreアプリにApp Sandboxを必須としている。

実装状況:

| 項目 | Store版の実装 |
| --- | --- |
| Bundle ID・データ | `org.btajp.solo-eikaiwa`、Store専用container、3211/3212番port |
| App Sandbox | main appにsandbox、マイク、network client/server、Bun実行に必要なJIT権限を付与 |
| solo-server | sandbox継承とJIT権限で署名し、Store配布識別子を環境へ固定 |
| whisper-cli・Keychain helper | sandbox継承署名。Keychainは`security` CLIを使わずSecurity frameworkで操作 |
| LLM | Store版だけClaude/Codex CLIを候補・catalog・spawn経路から除外し、OpenAI公式・OpenAI互換に限定 |
| 自動更新 | Store featureではupdater plugin、起動確認、メニューをコンパイル対象外にする |
| Store設定 | 専用Tauri config、entitlements、profile埋込み、署名、pkg、Apple検証・upload scriptを追加 |
| Whisper model | 固定URL・サイズ・SHA-256で検証して利用者が取得。追加resourceとしての審査判断はReview Notesへ明記 |

技術スパイクでは、Appleがhelperの基本形として示すsandboxとinheritだけではBun runtimeが
`SharedArrayBuffer`を初期化できず終了した。solo-serverにJITとunsigned executable memoryを追加した状態では、
Sandbox内でmain app、sidecar、`/api/llm-settings`、`/api/llm-models`の起動を確認済みである。
ただし、この組合せをAppleが受理するかは本番証明書で作ったpkgのvalidate結果を最終判定とする。

## 6. Mac App Store用のApple側資産

ここからはStore版のsandbox E2Eが通った後に行う。

### 6.1 Explicit App ID

Account HolderまたはAdminが「Certificates, Identifiers & Profiles > Identifiers」でApp IDを作る。

- Platform: App
- Type: Explicit App ID
- Bundle ID: `org.btajp.solo-eikaiwa`
- Capability: App Sandboxと実際に使う機能だけ

### 6.2 Store用証明書

Account HolderまたはAdminが、開発担当者のMacで作ったCSRを使って次を作る。

- Apple DistributionまたはMac App Distribution: `.app` の署名用
- Mac Installer Distribution: App Storeへ送る `.pkg` の署名用

Developer ID ApplicationとMac Installer Distributionを混同しない。
Developer IDはGitHub等のStore外配布、Mac Installer DistributionはMac App Store提出用。

### 6.3 Mac App Store Connect provisioning profile

Account HolderまたはAdminが次の条件で作成する。

- Distribution: Mac App Store Connect
- App ID: 6.1で作ったExplicit App ID
- Certificate: 6.2のapp署名用distribution certificate

ダウンロードした `.provisionprofile` は秘密鍵ではないが、組織の配布資産としてリポジトリ外で管理する。
Store専用Tauri configから `embedded.provisionprofile` としてapp bundleへ入れる。

## 7. Store用build、pkg、upload

Storeの公開値とローカル資産は、リポジトリ外の`app-store.env`へ置く。必要な項目はBundle ID、
単調増加するbuild number、Team ID、app用とinstaller用のidentity、provisioning profile、
App Store Connect API keyの識別子・issuer・秘密鍵pathである。ファイルは所有者だけが読める権限にする。

```bash
chmod 600 "$HOME/.config/solo-eikaiwa/app-store.env"
./scripts/build-app-store.sh sandbox  # ad-hoc署名でSandbox起動確認
./scripts/build-app-store.sh package  # Store署名、pkg作成、Apple validate
./scripts/build-app-store.sh upload   # packageとvalidate後、App Store Connectへupload
```

scriptはrelease検証、Store専用sidecar/resources、Tauri app、nested helper、main app、installer pkgの順に
build・署名し、Bundle ID、build number、profile、署名を確認してからAppleへ送る。

Tauri公式手順のpkg生成形式:

```bash
xcrun productbuild \
  --sign "Mac Installer Distribution: ORGANIZATION NAME (TEAMID)" \
  --component "PATH/solo-eikaiwa.app" /Applications \
  "solo-eikaiwa.pkg"
```

アップロードはXcode、Transporter、またはAppleがサポートするCLIを使う。
uploadできるroleはAccount Holder、Admin、App Manager、Developer。

## 8. App Store Connectの登録と審査

### 8.1 アプリレコード

Account Holder、Admin、またはApp Managerが「Apps > + > New App」で作成する。

- Platform: macOS
- Name: Store表示名
- Primary Language: 日本語または英語
- Bundle ID: 登録済みExplicit App ID
- SKU: 組織内で一意の不変値
- User Access: 開発担当者を含める

開発者名は既存iOSアプリと同じ `Business Technology Association Japan` であることを確認してからCreateする。

### 8.2 メタデータ

最低限、次を用意する。

- 説明、キーワード、subtitle
- category
- macOSスクリーンショット
- support URL
- privacy policy URL
- copyright（`© <YEAR> Business Technology Association Japan`）
- age rating
- 配布地域と価格
- export compliance
- App Reviewの連絡先

privacy回答では、ローカル保存だけでなく、利用者が選択したLLM/TTS providerへテキストを送る機能も含めて評価する。
「収集なし」を自動選択せず、組織のプライバシーポリシーと第三者providerの扱いを一致させる。

### 8.3 Review Notes

審査担当者が再現できるよう、少なくとも次を英語で説明する。

- 初回起動後にローカルsidecarを起動すること
- マイク許可が必要な理由
- STTはローカル実行であること
- モデルの取得方法または同梱方法
- LLM/TTSは利用者が選択し、未設定でも使える機能があること
- 審査用の具体的な操作手順
- 外部accountが必要なら有効なdemo account。不要なら不要と明記

### 8.4 TestFlightと提出

1. upload後、buildのprocessing完了を待つ
2. TestFlightまたは内部配布でsandbox版を実機確認する
3. versionへbuildを選択する
4. metadata、privacy、輸出規制、価格・地域の未入力を解消する
5. 「Add for Review」でdraft submissionへ追加する
6. Account Holder、Admin、またはApp Managerが「Submit for Review」を実行する
7. App Reviewの質問・reject理由にはApp Store Connectで返信する

## 9. Role別の最小操作表

| 操作 | Account Holder | Admin | App Manager | Developer |
| --- | --- | --- | --- | --- |
| 最新契約への同意 | 必須 | 不可 | 不可 | 不可 |
| Developer ID証明書の通常発行 | 必須 | 不可 | 不可 | 不可 |
| App Store Connect APIの初回利用申請 | 必須 | 不可 | 不可 | 不可 |
| Team API Key生成 | 可 | 可 | 不可 | 不可 |
| App ID・Store用distribution証明書・profile | 可 | 可 | 不可 | 不可 |
| App record作成 | 可 | 可 | 可 | 不可 |
| build upload | 可 | 可 | 可 | 可 |
| App Review提出 | 可 | 可 | 可 | 不可 |
| 有料契約への同意 | 必須 | 不可 | 不可 | 不可 |

## 10. Account Holderへの依頼文テンプレート

```text
solo-eikaiwaのmacOS配布をDeveloper ID署名・公証し、その後Mac App Storeへ提出したいです。
Apple Accountや2FAコードの共有は不要です。以下だけお願いします。

1. App Store Connectで私をAdminとして招待
2. 未同意の最新契約があればAccount Holderとして同意
3. Users and Access > IntegrationsでApp Store Connect APIのRequest Access
4. 私のMacで作ったCSRを使い、Developer ID Application証明書を発行して.cerを返送
5. 有料公開にする場合のみPaid Apps Agreement、税務、銀行情報を完了

Developer IDの秘密鍵は私のMacに残るため、.p12やApple Accountのパスワード共有は不要です。
Store用のApp ID、distribution証明書、provisioning profileはAdmin招待後に私が作業します。
```

## 11. 完了判定

### GitHub署名・公証

- Developer ID Application identityが秘密鍵付きでKeychainにある
- App Store Connect Team API Keyが使える
- release scriptが署名、公証、staple、更新署名、依存監査を完走する
- GitHubから再取得したdmgがGatekeeperでacceptedになる
- 署名済みversionへの更新とマイク権限を実機確認する

### Mac App Store

- production Bundle IDが確定している
- Store専用sandbox buildが全機能のE2Eを通る
- helperがsandbox継承署名で動く
- self-updaterと審査不能な外部CLI経路がStore buildで無効
- モデル配布方式がReview Guidelineと整合する
- Apple Distribution系証明書、Mac Installer Distribution証明書、profileが揃う
- pkgのvalidate/uploadが成功する
- privacy、metadata、review notesが完成する
- TestFlight確認後にApp Reviewへ提出する

## 12. 公式資料

- [Apple Developer Programのroles](https://developer.apple.com/help/account/access/roles)
- [Developer ID certificateの作成](https://developer.apple.com/help/account/certificates/create-developer-id-certificates/)
- [CSRの作成](https://developer.apple.com/help/account/certificates/create-a-certificate-signing-request)
- [App Store Connect API](https://developer.apple.com/help/app-store-connect/get-started/app-store-connect-api)
- [App IDの登録](https://developer.apple.com/help/account/identifiers/register-an-app-id)
- [Mac App Store Connect provisioning profile](https://developer.apple.com/help/account/provisioning-profiles/create-an-app-store-provisioning-profile/)
- [App Sandbox](https://developer.apple.com/documentation/security/protecting-user-data-with-app-sandbox)
- [sandboxed appへのhelper tool組み込み](https://developer.apple.com/documentation/Xcode/embedding-a-helper-tool-in-a-sandboxed-app)
- [App recordの作成](https://developer.apple.com/help/app-store-connect/create-an-app-record/add-a-new-app/)
- [build upload](https://developer.apple.com/help/app-store-connect/manage-builds/upload-builds/)
- [App Reviewへの提出](https://developer.apple.com/help/app-store-connect/manage-submissions-to-app-review/submit-an-app)
- [App privacy](https://developer.apple.com/help/app-store-connect/manage-app-information/manage-app-privacy)
- [App Review Guidelines](https://developer.apple.com/app-store/review/guidelines/)
- [TauriのApp Store手順](https://v2.tauri.app/distribute/app-store/)
