//! 半自動アップデート: 起動時チェック → ネイティブダイアログ → 1クリック更新 → 再起動。
//! 更新UXは全てRust側（ダイアログ・メニュー）で完結させる。本体UI（localhost配信のwebview）
//! へのIPCはゼロ権限のまま（capabilities/default.json のコメント参照）。

/// 手動DL先。適用失敗・チェック失敗時の情報的な案内に使う。
pub(crate) const RELEASES_URL: &str = "https://github.com/btajp/solo-eikaiwa/releases";

/// ダイアログ文言の言語。クライアント側i18n（webview内）とは独立した、ネイティブUI専用の選択。
#[derive(Debug, PartialEq, Clone, Copy)]
pub(crate) enum Lang {
    Ja,
    En,
}

/// システムロケール文字列からダイアログ言語を選ぶ。`ja*` のみ日本語、他は英語。
pub(crate) fn pick_lang(locale: Option<&str>) -> Lang {
    match locale {
        Some(l) if l.starts_with("ja") => Lang::Ja,
        _ => Lang::En,
    }
}

/// 確認ダイアログ（2ボタン）用の文言一式。
pub(crate) struct PromptText {
    pub title: String,
    pub body: String,
    pub ok: String,
    pub cancel: String,
}

/// 情報ダイアログ（1ボタン）用の文言。
pub(crate) struct InfoText {
    pub title: String,
    pub body: String,
}

/// 新版検知時の確認ダイアログ。更新は必ずユーザーの明示クリックで実行する（研究制約）。
pub(crate) fn update_prompt_text(lang: Lang, current: &str, latest: &str) -> PromptText {
    match lang {
        Lang::Ja => PromptText {
            title: "アップデート".to_string(),
            body: format!(
                "solo-eikaiwa v{latest} が利用可能です（現在 v{current}）。\n\
                 今すぐダウンロードして更新しますか？\n更新後は自動で再起動します。"
            ),
            ok: "更新する".to_string(),
            cancel: "今回はしない".to_string(),
        },
        Lang::En => PromptText {
            title: "Update Available".to_string(),
            body: format!(
                "solo-eikaiwa v{latest} is available (you have v{current}).\n\
                 Download and install now?\nThe app will restart automatically."
            ),
            ok: "Update".to_string(),
            cancel: "Not Now".to_string(),
        },
    }
}

/// 手動チェックで「最新だった」場合の情報表示。
pub(crate) fn manual_latest_text(lang: Lang, current: &str) -> InfoText {
    match lang {
        Lang::Ja => InfoText {
            title: "アップデート".to_string(),
            body: format!("お使いのバージョン（v{current}）が最新です。"),
        },
        Lang::En => InfoText {
            title: "Up to Date".to_string(),
            body: format!("You're on the latest version (v{current})."),
        },
    }
}

/// 更新の適用（DL・差し替え）に失敗した場合の情報表示。
/// App Translocation（/Applications 未移動）が典型原因のため、移動のヒントも添える。
pub(crate) fn install_failed_text(lang: Lang) -> InfoText {
    match lang {
        Lang::Ja => InfoText {
            title: "アップデート".to_string(),
            body: format!(
                "自動更新を完了できませんでした。\n最新版は以下から手動でダウンロードできます:\n{RELEASES_URL}\n\
                 （アプリを /Applications に移動してから起動すると自動更新できるようになります）"
            ),
        },
        Lang::En => InfoText {
            title: "Update".to_string(),
            body: format!(
                "The update could not be installed automatically.\nYou can download the latest version manually:\n{RELEASES_URL}\n\
                 (Moving the app into /Applications enables automatic updates.)"
            ),
        },
    }
}

/// 手動チェックで確認自体ができなかった（オフライン等）場合の情報表示。
/// 「更新に失敗した」と誤解させないよう、適用失敗（`install_failed_text`）とは別文言にする。
pub(crate) fn manual_check_failed_text(lang: Lang) -> InfoText {
    match lang {
        Lang::Ja => InfoText {
            title: "アップデート".to_string(),
            body: format!(
                "アップデートを確認できませんでした（ネットワーク接続をご確認ください）。\n\
                 最新版の有無は以下でも確認できます:\n{RELEASES_URL}"
            ),
        },
        Lang::En => InfoText {
            title: "Update".to_string(),
            body: format!(
                "Could not check for updates (please check your network connection).\n\
                 You can also check the latest release here:\n{RELEASES_URL}"
            ),
        },
    }
}

/// メニュー項目「アップデートを確認…」のラベル。
pub(crate) fn check_menu_label(lang: Lang) -> &'static str {
    match lang {
        Lang::Ja => "アップデートを確認…",
        Lang::En => "Check for Updates…",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pick_lang_ja_for_japanese_locales() {
        assert_eq!(pick_lang(Some("ja")), Lang::Ja);
        assert_eq!(pick_lang(Some("ja-JP")), Lang::Ja);
    }

    #[test]
    fn pick_lang_en_for_others_and_missing() {
        assert_eq!(pick_lang(Some("en-US")), Lang::En);
        assert_eq!(pick_lang(Some("fr")), Lang::En);
        assert_eq!(pick_lang(None), Lang::En);
    }

    #[test]
    fn update_prompt_contains_both_versions() {
        let t = update_prompt_text(Lang::Ja, "0.29.0", "0.30.0");
        assert!(t.body.contains("0.29.0") && t.body.contains("0.30.0"));
        let t = update_prompt_text(Lang::En, "0.29.0", "0.30.0");
        assert!(t.body.contains("0.29.0") && t.body.contains("0.30.0"));
    }

    #[test]
    fn install_failed_text_mentions_releases_url() {
        // 適用失敗時は手動DL先（Releases）を必ず情報的に案内する（研究制約: 警告調・強要なし）
        assert!(install_failed_text(Lang::Ja).body.contains(RELEASES_URL));
        assert!(install_failed_text(Lang::En).body.contains(RELEASES_URL));
    }

    #[test]
    fn manual_latest_text_mentions_current_version() {
        assert!(manual_latest_text(Lang::Ja, "0.29.0").body.contains("0.29.0"));
        assert!(manual_latest_text(Lang::En, "0.29.0").body.contains("0.29.0"));
    }

    #[test]
    fn manual_check_failed_text_mentions_releases_url() {
        // 手動チェックの通信失敗は「確認できなかった」事実のみ伝える（更新失敗とは別文言）
        assert!(manual_check_failed_text(Lang::Ja).body.contains(RELEASES_URL));
        assert!(manual_check_failed_text(Lang::En).body.contains(RELEASES_URL));
    }
}
