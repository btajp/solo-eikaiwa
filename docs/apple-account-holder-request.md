# Account Holderへの依頼事項

最終確認日: 2026-07-13

## 目的

solo-eikaiwaのGitHub配布版をDeveloper ID署名・Apple公証済みで公開するための依頼事項です。
Mac App Store版は開発・提出・公開しません。

Apple Account、パスワード、2要素認証コード、秘密鍵を開発担当者へ共有する必要はありません。
Account Holder roleを移管する必要もありません。

## Account Holderにお願いすること

### 1. membershipと契約の確認

Apple DeveloperへAccount Holder本人がログインし、次を確認してください。

- Apple Developer Program membershipが有効
- 未同意のApple Developer Program契約がない

### 2. Developer ID Application証明書の発行

開発担当者から渡す `.certSigningRequest` を使います。

1. Apple Developerの「Certificates, Identifiers & Profiles」を開く
2. 「Certificates > + > Developer ID」を選ぶ
3. 「Developer ID Application」を選ぶ
4. 開発担当者のCSRをアップロードする
5. 生成された `.cer` を開発担当者へ返す

CSRは開発担当者のMacで作成するため、対応する秘密鍵はそのMacのKeychainから出ません。
`.p12`、秘密鍵、Apple Accountのパスワードを渡す必要はありません。

### 3. 公証用APIの利用可否確認

App Store Connectの「Users and Access > Integrations」でTeam Keysが利用できることを確認してください。
初回のRequest Accessが必要な場合だけAccount Holderが申請します。作成するAPIキーはNotary Serviceへの
公証送信にだけ使い、Storeのアプリ提出には使いません。

## 返してもらうもの

- membershipと契約に問題がないことの確認
- Developer ID Applicationの `.cer`
- 公証用Team API Keyを作成できる状態であることの確認

Apple Accountのパスワード、2FAコード、秘密鍵は返却物に含めないでください。

## 対応不要なもの

- App Store Connectのアプリレコード
- Store用Bundle ID・App ID
- Apple Distribution / Mac Installer Distribution証明書
- Mac App Store用provisioning profile
- 価格、配布地域、審査、税務・銀行情報

## そのまま送れる依頼文

```text
solo-eikaiwaのGitHub配布版をDeveloper ID署名・Apple公証済みで公開するため、
次の対応をお願いします。Mac App Storeへの提出は行いません。

1. Apple Developer Programのmembershipが有効で、未同意の契約がないことを確認
2. 添付するCSRを使ってDeveloper ID Application証明書を発行し、.cerを返送
3. App Store ConnectのUsers and Access > Integrationsで、公証用Team API Keyを作成できることを確認

CSRは私のMacで作成しているため、秘密鍵は私のKeychainに残ります。
Apple Account、パスワード、2FAコード、.p12、秘密鍵の共有は不要です。
```

## 完了チェックリスト

- [ ] membershipが有効
- [ ] 未同意の契約がない
- [ ] 開発担当者のCSRからDeveloper ID Applicationを発行済み
- [ ] `.cer` を開発担当者へ返却済み
- [ ] 公証用Team API Keyを作成可能

## Apple公式資料

- [Developer ID証明書の作成](https://developer.apple.com/help/account/certificates/create-developer-id-certificates/)
- [macOSソフトウェアの公証](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution)
- [App Store Connect API](https://developer.apple.com/help/app-store-connect/get-started/app-store-connect-api)
