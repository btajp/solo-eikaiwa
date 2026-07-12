# Mac App Store提出メタデータ

最終更新: 2026-07-12

この文書はApp Store Connectへ入力する公開情報と審査情報の正本である。秘密鍵、APIキー、Team ID、
個人のApple Account情報は記録しない。

## アプリレコード

| 項目 | 値 |
| --- | --- |
| Platform | macOS |
| Name | `solo-eikaiwa` |
| Primary Language | Japanese |
| Bundle ID | `org.btajp.solo-eikaiwa` |
| SKU | `solo-eikaiwa-macos-001` |
| Primary Category | Education |
| Secondary Category | Productivity |
| Developer | `Business Technology Association Japan` |
| Version | `0.29.1` |
| Copyright | `2026 Business Technology Association Japan` |
| Support URL | `https://btajp.github.io/solo-eikaiwa/support.html` |
| Marketing URL | `https://btajp.github.io/solo-eikaiwa/` |
| Privacy Policy URL | `https://btajp.github.io/solo-eikaiwa/privacy.html` |

価格と配布地域は外部状態を変更する前に確定する。OSSとして無料、利用可能な全地域を第一候補とする。

## 日本語ローカライズ

### Subtitle

```text
毎日5分からの英会話セルフトレーニング
```

### Promotional Text

```text
録音と文字起こしはMac内。5分ドリル、4/3/2、ロールプレイ、暗記例文390、リスニングを、自分のペースで続けられる英会話練習アプリです。
```

### Keywords

```text
英会話,英語学習,スピーキング,発音,シャドーイング,リスニング
```

### Description

```text
solo-eikaiwaは、毎日5分から自分のペースで続けられる、Mac向けの英会話セルフトレーニングです。

録音と文字起こしはMac内で処理・保存します。AIを使う会話、添削、解説では、必要なテキストだけを、設定画面で利用者が選んだOpenAI公式またはOpenAI互換の接続先へ送ります。マイク音声そのものは送信しません。

主な練習
・5〜10分の音読、4/3/2、ロールプレイ、シャドーイング
・自由会話と場面別ロールプレイ
・音声付き暗記例文390と間隔反復
・レベル別のリスニング教材42本
・発話速度、練習履歴、月次レビューによる振り返り

学習量のノルマ、連続日数が切れる演出、自動降格はありません。難易度調整は情報として提案し、反映するかは利用者が選びます。

AI接続を設定しなくても、例文、リスニング、シャドーイング、録音の文字起こしを利用できます。クラウドAI機能の利用には、利用者自身のAPIキーまたは設定したOpenAI互換接続先が必要です。

対応環境: Apple Silicon搭載Mac、macOS 13.3以降
```

## English localization

### Subtitle

```text
Daily English speaking gym
```

### Promotional Text

```text
Practice speaking in five minutes a day. Recordings and transcripts stay on your Mac, with focused drills, listening, spaced repetition, and optional AI feedback.
```

### Keywords

```text
english,speaking,pronunciation,shadowing,listening,fluency,practice
```

### Description

```text
solo-eikaiwa is a self-paced English speaking gym for Apple Silicon Macs. Start with a five-minute drill or combine reading aloud, 4/3/2 fluency practice, role-play, shadowing, listening, and spaced-repetition sentences.

Recordings and speech-to-text processing stay on your Mac. When you explicitly use an AI conversation, correction, explanation, or cloud TTS feature, the app sends only the required text and context to the OpenAI or OpenAI-compatible endpoint you selected. Microphone audio is not sent to an AI provider.

Included practice:
• Five-to-ten-minute reading, 4/3/2, role-play, and shadowing drills
• Free conversation and scenario-based role-play
• 390 audio-supported sentences with spaced repetition
• 42 listening lessons across levels and domains
• Speaking-rate trends, practice history, and monthly reflection

There are no streak-loss effects, quotas, or automatic demotion. Difficulty changes are shown as information and applied only with your approval.

Example sentences, listening, shadowing, and local transcription remain available without an AI connection. Optional cloud AI features require your own API key or an OpenAI-compatible endpoint you configure.

Requires an Apple Silicon Mac running macOS 13.3 or later.
```

## App Privacy回答

Appleの質問には、運営者が受信しないローカルデータだけでなく、利用者が選ぶAI providerの取扱いも含めて保守的に回答する。
同じ内容をStore appの`PrivacyInfo.xcprivacy`にも記録し、trackingなし、Other User Content、
App Functionality、利用者に紐づき得る、という回答をbinaryと一致させる。

| 質問 | 回答 |
| --- | --- |
| Data collection | Yes |
| Data type | User Content > Other User Content |
| Purpose | App Functionality |
| Linked to the user | Yes。利用者自身のprovider account/API keyに紐づき得るため |
| Used for tracking | No |
| Audio Data | No。マイク録音はMac外へ送信しない |
| Diagnostics / Usage Data | No。診断ログと利用履歴は運営者へ送信しない |

privacy回答と公開ポリシーは、providerやtelemetryの実装を変更したversionごとに再確認する。

## Export compliance

- `ITSAppUsesNonExemptEncryption=false`
- アプリ独自の暗号方式は実装しない
- HTTPS、macOS Keychain、Apple標準framework等の標準暗号だけを利用する

## App Review情報

### Contact

- Name: `Shintaro Okamura`
- Organization: `Business Technology Association Japan`
- Emailと電話番号はApp Store Connectの組織連絡先から入力し、リポジトリへ記録しない
- Sign-in required: No

### Review Notes

```text
solo-eikaiwa is a local-first English speaking practice app for Apple Silicon Macs.

No account is required. On launch, the app starts its bundled local server on 127.0.0.1:3211 (or 3212 if needed). The server exits when the user quits the app normally. The app does not install a login item or a separate background service.

Microphone permission is used only to record speaking practice. Audio is transcribed locally by the bundled whisper.cpp executable and is not sent to an AI provider.

To test without an external AI account:
1. Open “390 Sentences” and play an example sentence.
2. Open “Listening” and play a lesson.
3. From the model setup banner, choose the smaller Whisper model. The download has a fixed URL, byte size, and SHA-256 checksum.
4. Record a short response after the model is ready and confirm that a transcript appears.

Conversation, correction, explanation, and cloud TTS features are optional. They require the reviewer to enter their own OpenAI API key or configure an OpenAI-compatible endpoint in Settings > API Keys and Settings > Model connections. The app never displays or returns a saved key. Claude and Codex command-line integrations are intentionally unavailable in the Mac App Store build because they would execute tools outside the App Sandbox.

The app has no analytics, advertising, tracking, or operator-hosted account service. Privacy policy: https://btajp.github.io/solo-eikaiwa/privacy.html
```

## スクリーンショット

Mac用は同一の16:10サイズで1〜10枚用意する。1280×800を標準とし、次の5画面を候補とする。

1. ホーム: 今日の練習と、短時間から始められる構成
2. 4/3/2: 準備支援と発話ラウンド
3. 暗記例文390: 産出、答え合わせ、自己評価
4. リスニング: レベル別教材と明示操作で開く訳・解説
5. 設定: APIキー、OpenAI公式、OpenAI互換の分離と処理場所の表示

実在する学習データだけを表示し、APIキー、ローカルpath、個人情報、デバッグUIを写さない。
