# macOS署名・公証・GitHub公開手順書

最終確認日: 2026-07-13

solo-eikaiwaのmacOS版はGitHub Releasesだけで公開する。Mac App Store版は開発・提出・公開しない。
Apple Accountのパスワード、2要素認証コード、秘密鍵を共有して作業してはいけない。

## 1. 公開方式

| 項目 | 方針 |
| --- | --- |
| 配布先 | GitHub Releases |
| 署名 | Developer ID Application |
| Apple側の検証 | Notary Serviceによる公証 |
| 成果物 | dmg、更新アーカイブ、SBOM、NOTICE、checksum |
| 更新 | アプリ内の署名検証付きself-updater |

App Store ConnectのAPIキーは公証の認証にだけ使う。Store用App ID、Apple Distribution証明書、
Mac Installer Distribution証明書、provisioning profile、アプリレコードは作成しない。

## 2. 役割分担

| 担当 | 主な作業 |
| --- | --- |
| Account Holder | membership・契約の確認、Developer ID Application証明書の発行 |
| 開発担当者 | CSR作成、証明書のインストール、公証用APIキー管理、署名・公証・GitHub公開 |

Account Holder roleを移管する必要はない。開発担当者のMacで作成したCSRを使えば、秘密鍵はそのMacから出ない。

## 3. 初回準備

### 3.1 CSRとDeveloper ID証明書

1. 開発担当者がキーチェーンアクセスを開く
2. 「証明書アシスタント > 認証局に証明書を要求」を選ぶ
3. Apple Accountのメールアドレスと識別しやすいCommon Nameを入力する
4. CA Email Addressは空欄にし、「ディスクに保存」を選ぶ
5. Account HolderがDeveloper ID Applicationを選び、CSRから証明書を発行する
6. 返却された `.cer` をCSR作成元のMacへインストールする

確認:

```bash
security find-identity -v -p codesigning
```

Keychainの「自分の証明書」で証明書と秘密鍵が組にならない場合は、別のMacで作ったCSRが使われている。

### 3.2 公証用APIキー

App Store Connectの「Users and Access > Integrations」でTeam API Keyを作成する。
このキーはNotary Serviceへの公証送信にだけ使用し、Storeのアプリ管理には使用しない。

管理対象:

- Key ID
- Issuer ID
- `AuthKey_<KEY_ID>.p8`

`.p8` は一度しかダウンロードできない。リポジトリ、Issue、PR、チャットへ貼らず、組織のsecret vaultで保管する。

### 3.3 updater署名鍵

Tauri updaterの秘密鍵もリポジトリ外で保管する。Developer ID秘密鍵・Apple APIキー・updater秘密鍵は
用途が異なるため、別々にバックアップし、公開鍵だけをアプリ設定へ含める。

## 4. release.env

標準リリーススクリプトを初回実行すると、リポジトリ外に設定テンプレートが作られる。

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

秘密値は例のままコミットせず、所有者だけが読める権限にする。

```bash
chmod 600 "$HOME/.config/solo-eikaiwa/release.env"
chmod 600 "$HOME/.appstoreconnect/private_keys/AuthKey_KEYID.p8"
```

## 5. 公開手順

1. `CHANGELOG.md`、README、package、Tauri、Cargoのversionを揃える
2. PRを作成し、必須CIとレビューを通してmainへmergeする
3. push済みでcleanなmainへ同期する
4. `./scripts/verify.sh release` を通す
5. `./scripts/release-desktop.sh <version>` を実行する

標準スクリプトはsidecar/native build、Developer ID署名、公証、staple、updater署名、SBOM・NOTICE・
checksum・provenance、GitHub Release公開までを一括で行う。Finder AppleScriptには依存しない。

## 6. 公開後の確認

GitHubからdmgを新しくダウンロードし、次を確認する。

```bash
codesign --verify --deep --strict --verbose=2 /Applications/solo-eikaiwa.app
spctl -a -t exec -vv /Applications/solo-eikaiwa.app
xcrun stapler validate /Applications/solo-eikaiwa.app
```

- Gatekeeperが受け入れる
- AuthorityがDeveloper ID Applicationである
- appとdmgのstaple検証が成功する
- 録音、STT、Claude、Codex、ローカルLLM、sidecarが動く
- ブラウザ版と同時起動できる
- updaterが署名を検証して更新できる

## 7. 公式資料

- [Developer ID証明書の作成](https://developer.apple.com/help/account/certificates/create-developer-id-certificates/)
- [macOSソフトウェアの公証](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution)
- [App Store Connect API](https://developer.apple.com/help/app-store-connect/get-started/app-store-connect-api)
