# スポット確認レポート（発音訓練・習慣化）

- 実施日: 2026-07-05
- 位置づけ: ディープリサーチ2回で検証を通過しなかった2領域（発音訓練・習慣化）について、定番文献の中核数値を Claude が Web 検索で直接確認したもの。
- **検証レベル: 「一次資料スポット確認」— 3票の敵対的検証は経ていない**。設計ではこの2領域を「小さく・可逆に」扱い、主構造には依存させない。

## (d) 発音訓練

### 知覚訓練 → 産出への転移（HVPT系）

- Sakai & Moorman 2018（*Applied Psycholinguistics* 39(1):187-224、25年分の知覚訓練研究のメタ分析）: 知覚訓練は知覚を中程度改善（**d = 0.92**）し、**訓練していない産出（発音）にも小〜中の改善（d = 0.54）が転移**する。効果は音素・学習環境・明示指導の有無・習熟度で調整される。
  - 出典: https://www.cambridge.org/core/journals/applied-psycholinguistics/article/abs/can-perception-training-improve-the-production-of-second-language-phonemes-a-metaanalytic-review-of-25-years-of-perception-training-research/57401D28450902EE96659AD10AA11488
- 含意: 複数話者の音声で minimal pair を聞き分ける HVPT 型ドリルは、「聞く練習だけで発音も少し良くなる」経路として費用対効果が高い。本システムは複数ボイスの TTS API を持つため、HVPT 素材を自前生成できる。

### 何を優先するか（機能負荷 × 明瞭性）

- Munro & Derwing 2006（*System* 34:520-531）: **機能負荷（functional load）の高い音素対立の誤りは、低い対立の誤りよりも理解しやすさ（comprehensibility）を大きく損なう**。指導は高機能負荷対立を優先すべき。
  - 出典: https://www.researchgate.net/publication/229363737_The_functional_load_principle_in_ESL_pronunciation_instruction_An_exploratory_study
- 明瞭性優先（intelligibility-first）はこの分野の実務コンセンサス（Munro & Derwing 1995 以降、Levis の Intelligibility Principle）: **ネイティブ様のアクセント除去は目標にせず、伝わることを目標にする**。
- 含意: 日本語話者の高機能負荷課題（/l/-/r/ など）に絞った少量の知覚ドリルで十分。アクセント矯正に時間を割かない。

## (e) 習慣化・継続

### 習慣形成の時間スケール

- Lally, van Jaarsveld, Potts & Wardle 2010（*European Journal of Social Psychology* 40(6):998-1009、96名・12週間の実地研究）: 同じコンテキストで毎日行う行動の自動性は**中央値66日**でプラトー到達（**個人差 18〜254日**）。**1回の欠落は習慣形成を実質的に妨げない**。
  - 出典: https://onlinelibrary.wiley.com/doi/10.1002/ejsp.674
- 含意: 3ヶ月（90日）チェックポイントは習慣自動化の中央値をカバーする妥当な期間。「1日欠けたらストリーク全損」の設計は研究的根拠がなく、罰的すぎる。

### 実装意図（implementation intentions）

- Gollwitzer & Sheeran 2006（*Advances in Experimental Social Psychology* 38:69-119、94独立テストのメタ分析）: 「状況Yになったら行動Xをする」という if-then 計画は目標達成に**中〜大の効果（d = 0.65）**。
  - 出典: https://www.sciencedirect.com/science/chapter/bookseries/abs/pii/S0065260106380021
- **【2026-07-05 訂正・第3弾リサーチで3票検証済み】** 原著者ら自身の2024年メタ分析（642検証、Sheeran, Listrom & Gollwitzer 2024）で、出版バイアス補正後 **d = 0.15** に大幅下方修正。効果は実在するが小さく、継続の主柱ではなく補助策。動機が強い場合にのみ機能する。詳細は [第3弾レポート](2026-07-05-continuation-research-phase3.md) B-8〜10。
- 含意: 「毎日30分やる」ではなく「**（例）朝コーヒーを淹れたら learn-english を開く**」の形でアンカー行動に紐付ける。アンカーはユーザー自身が決める（1行だけ・詳細化しない）。

## 設計への反映（要約）

1. 発音はオプションのマイクロブロック（週2〜3回×5分、高機能負荷対立の HVPT 型知覚ドリル）に限定。明瞭性優先、アクセント矯正はしない。
2. 習慣設計: ユーザーが決めた if-then アンカー、週5日達成ベースの緩いストリーク（1日欠落を罰しない）、開始1クリック、90日を第一の習慣化地平線とする。

> **2026-07-17 改訂注記（2について）**: 「週5日達成ベースの緩いストリーク」はストリーク自体を導入せず、練習日カレンダー（情報的表示のみ）へ方針置換済み。根拠は[第3弾リサーチ](2026-07-05-continuation-research-phase3.md)の統合設計推奨 D-4（失うと痛いストリークを避ける）と AGENTS.md の binding 制約（喪失演出を導入しない）。
